import bcrypt from "bcrypt";
import mongoose, { Types } from "mongoose";
import OTP from "../models/otpModel.js"
import User from "../models/userModel.js";
import Directory from "../models/directoryModel.js";
import redisClient from "../config/redis.js";
import { getUserFromAuthCode } from "../services/googleAuthService.js"
import { sendOtpService } from "../services/sendOtpService.js"
import { changePasswordSchema, loginSchema, registerSchema, sendOtpSchema, verifyOtpSchema } from "../validators/authSchema.js";
import { enforceDeviceLimit, createSession, deleteUserSessions } from "../utils/sessionUtils.js";
import { isOwnedProfilePictureURL } from "../services/cloudflareR2Service.js";
import { trace, SpanStatusCode } from "@opentelemetry/api";

const tracer = trace.getTracer("storageApp-auth");

const MAX_OTP_ATTEMPTS = 5;

// Valid bcrypt hash (cost 12) of a throwaway string. Compared against when the
// email is unknown so "no such user" takes as long as "wrong password".
const DUMMY_PASSWORD_HASH = "$2b$12$RYWsiRMDdUAzh5E1boFpSeeNV9doPXgM6Ed7n8/l.olJX.pRWfBRK";

// Counts a wrong OTP guess for this email and invalidates the code after
// MAX_OTP_ATTEMPTS, so a 4-digit code can't be brute-forced. Never throws.
async function recordFailedOtpAttempt(email) {
    try {
        const record = await OTP.findOneAndUpdate(
            { email },
            { $inc: { attempts: 1 } },
            { returnDocument: "after" },
        );
        if (record && record.attempts >= MAX_OTP_ATTEMPTS) {
            await OTP.deleteOne({ email });
        }
    } catch (err) {
        console.error("Could not record failed OTP attempt", err);
    }
}


export const sendOtp = async (req, res) => {
    const parsed = sendOtpSchema.safeParse(req.body);

    if (!parsed.success) {
        return res.status(400).json({
            error: parsed.error.issues[0].message,
        });
    }
    const { email } = parsed.data;

    const result = await sendOtpService(email)
    if (!result.success) {
        return res.status(400).json({ error: result.error || "Unable to sent Otp!" })
    }

    return res.json(result)
}

export const verifyOtp = async (req, res) => {
    const parsed = verifyOtpSchema.safeParse(req.body);

    if (!parsed.success) {
        return res.status(400).json({
            error: parsed.error.issues[0].message,
        });
    }
    const { email, otp } = parsed.data;
    
    const result = await OTP.findOne({ email, otp })
    if (!result) {
        await recordFailedOtpAttempt(email);
        return res.status(400).json({ error: "Invalid or Expired Otp!" })
    }
    return res.json({ message: "Otp verified" })
}

export const loginWithGoogle = async (req, res, next) => {
    const transactionSession = await mongoose.startSession();
    let txnStarted = false;

    try {
        const { code } = req.body;
        if (!code) {
            return res.status(400).json({ error: "Authorization code is required" });
        }

        const userData = await getUserFromAuthCode(code);
        if (userData.error) return res.status(400).json({ error: userData.error });
        const { name, email, picture } = userData;

        const user = await User.findOne({ email })
        if (user) {
            if (user.isDeleted) {
                return res.status(403).json({ error: "Your account is disabled! Contact Admin to recover." })
            }
            await enforceDeviceLimit(user.id, user.accessDevice);

            // Same behavior as before (only refresh from Google when the
            // stored picture isn't already a Google picture), PLUS: never
            // overwrite a custom (self-uploaded) R2 profile picture.
            const hasCustomPicture = isOwnedProfilePictureURL(user.picture, user._id.toString());
            if (!hasCustomPicture && !user.picture.includes("googleusercontent.com")) {
                user.picture = picture
                await user.save()
            }

            await createSession(res, user.id)
            return res.json({ message: "User logged in with google" });
        }

        const rootDirId = new Types.ObjectId();
        const userId = new Types.ObjectId();

        txnStarted = true;
        transactionSession.startTransaction();
        await Directory.insertOne(
            {
                _id: rootDirId,
                name: `root-${email}`,
                parentDirId: null,
                userId,
            },
            { session: transactionSession },
        );
        await User.insertOne(
            {
                _id: userId,
                name,
                email,
                picture,
                rootDirId,
            },
            { session: transactionSession },
        );
        await transactionSession.commitTransaction();

        await createSession(res, userId)
        return res.status(201).json({ message: "User Registered with Google & Logged In" });
    } catch (err) {
        if (txnStarted) {
            await transactionSession.abortTransaction();
        }
        next(err);
    } finally {
        await transactionSession.endSession();
    }
}

export const register = async (req, res, next) => {
    const parsed = registerSchema.safeParse(req.body);
    if (!parsed.success) {
        return res.status(400).json({
            error: parsed.error.issues[0].message,
        });
    }
    const { name, email, password, otp } = parsed.data;

    const otpRecord = await OTP.findOneAndDelete({ email, otp })
    if (!otpRecord) {
        await recordFailedOtpAttempt(email);
        return res.status(400).json({ error: "Invalid or Expired Otp!" })
    }

    const rootDirId = new Types.ObjectId();
    const userId = new Types.ObjectId();
    const session = await mongoose.startSession();
    try {
        session.startTransaction();
        await Directory.insertOne(
            {
                _id: rootDirId,
                name: `root-${email}`,
                parentDirId: null,
                userId,
            },
            { session },
        );
        await User.insertOne(
            {
                _id: userId,
                name,
                email,
                password,
                rootDirId,
            },
            { session },
        );
        await session.commitTransaction();
        return res.status(201).json({ message: "User Registered!" });
    } catch (err) {
        await session.abortTransaction();
        if (err.code === 121) {
            return res
                .status(400)
                .json({ error: "Invalid Input! please enter valid details" });
        } else if (err.code === 11000) {
            return res
                .status(409)
                .json({ error: "User already exists!, Sign in to continue..." });
        } else {
            next(err);
        }
    } finally {
        await session.endSession();
    }
};

export const login = async (req, res) => {
    const parsed = loginSchema.safeParse(req.body);

    if (!parsed.success) {
        return res.status(400).json({
            error: "Invalid Credentials",
        });
    }

    const { email, password } = parsed.data;

    const user = await User.findOne({ email });

    if (!user) {
        // Burn the same bcrypt time as a real check so response timing
        // doesn't reveal which emails are registered.
        await bcrypt.compare(password, DUMMY_PASSWORD_HASH);
        return res.status(404).json({
            error: "Invalid email or password!",
        });
    } else if (user.isDeleted) {
        return res.status(403).json({
            error: "Your account is disabled! Contact Admin to recover.",
        });
    } else if (!user.password) {
        return res.status(400).json({
            error: "This account uses Google Sign-In. Please continue with Google.",
        });
    }

    const isPasswordValid = await tracer.startActiveSpan(
        "auth.compare_password",
        async (span) => {
            try {
                const result = await user.comparePassword(password);

                span.setStatus({
                    code: SpanStatusCode.OK,
                });

                return result;
            } catch (error) {
                span.recordException(error);

                span.setStatus({
                    code: SpanStatusCode.ERROR,
                });

                throw error;
            } finally {
                span.end();
            }
        },
    );

    if (!isPasswordValid) {
        return res.status(404).json({
            error: "Invalid email or password!",
        });
    }

    await enforceDeviceLimit(user.id, user.accessDevice);
    await createSession(res, user._id);

    return res.status(200).json({
        message: "Login Successful",
    });
};

export const logout = async (req, res) => {
    await redisClient.del(`session:${req.signedCookies.sid}`)
    res.clearCookie("sid");
    return res.json({ message: "User Logged Out!" });
};

export const logoutAll = async (req, res) => {
    await deleteUserSessions(req.user._id)
    res.clearCookie("sid");
    return res.status(200).json({
        message: "Logged out from all devices!"
    });
};

export const changePassword = async (req, res) => {
    const parsed = changePasswordSchema.safeParse(req.body);

    if (!parsed.success) {
        return res.status(400).json({
            error: parsed.error.issues[0].message,
        });
    };
    const data = parsed.data;

    const user = await User.findById(req.user._id);

    if (!user) {
        return res.status(404).json({
            error: "User not found.",
        });
    };

    const hasPassword = !!user.password;

    if (hasPassword) {
        if (!data.currentPassword) {
            return res.status(400).json({
                error: "Current password is required.",
            });
        };

        const ok = await user.comparePassword(data.currentPassword);

        if (!ok) {
            return res.status(400).json({
                error: "Current password is incorrect.",
            });
        }
    };

    user.password = data.newPassword;

    await user.save();

    return res.json({
        message: hasPassword
            ? "Password changed successfully."
            : "Password set successfully.",
    });
};
