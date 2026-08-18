import { randomUUID } from "crypto";
import OTP from "../models/otpModel.js";
import User from "../models/userModel.js";
import File from "../models/fileModel.js";
import redisClient from "../config/redis.js";
import mongoose, { Types } from "mongoose";
import Directory from "../models/directoryModel.js";
import {
  deleteR2Files,
  uploadProfilePicture,
  deleteProfilePicture,
  getProfilePictureURL,
  getProfilePictureKeyFromURL,
  isOwnedProfilePictureURL,
} from "../services/cloudflareR2Service.js";
import { changePasswordSchema, loginSchema, registerSchema, updateProfileSchema } from "../validators/authSchema.js";
import { updateDirectorySize } from "./fileController.js";
import { createSession, deleteUserSessions, enforceDeviceLimit } from "../utils/sessionUtils.js";
import { getDirectoryContent } from "../utils/directoryTree.js";
import { processProfileImage } from "../utils/processProfileImage.js";

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
  const parsed = loginSchema.safeParse(req.body)
  if (!parsed.success) {
    return res.status(400).json({
      error: parsed.error.issues[0].message,
    });
  }
  const { email, password } = parsed.data;

  const user = await User.findOne({ email });
  if (!user) {
    return res.status(404).json({ error: "Invalid email or password!" });
  } else if (user.isDeleted) {
    return res.status(403).json({ error: "Your account is disabled! Contact Admin to recover." })
  } else if (!user.password) {
    return res.status(400).json({
      error: "This account uses Google Sign-In. Please continue with Google.",
    });
  }
  const isPasswordValid = await user.comparePassword(password);
  if (!isPasswordValid) {
    return res.status(404).json({ error: "Invalid email or password!" });
  }

  await enforceDeviceLimit(user.id, user.accessDevice);
  await createSession(res, user._id);

  return res.status(200).json({ message: "Login Successful" });
};

export const currentLoggedUser = async (req, res) => {
  return res.status(200).json({
    id: req.user._id,
    name: req.user.name,
    email: req.user.email,
    picture: req.user.picture,
    role: req.user.role,
    hasPassword: !!req.user.password,
    createdAt: req.user.createdAt,
    maxStorageInBytes: req.user.maxStorageInBytes,
    usedStorageInBytes: req.user.usedStorageInBytes,
  });
};

export const updateProfile = async (req, res) => {
  const parsed = updateProfileSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({
      error: parsed.error.issues[0].message,
    });
  }
  const { name } = parsed.data;
  const pictureFile = req.file;

  if (!name && !pictureFile) {
    return res.status(400).json({
      error: "Provide a name or a profile image to update.",
    });
  }

  const user = await User.findById(req.user._id);
  if (!user) {
    return res.status(404).json({ error: "User not found." });
  }

  let newImageKey = null;

  if (pictureFile) {
    let processedBuffer;
    try {
      processedBuffer = await processProfileImage(pictureFile.buffer);
    } catch {
      return res.status(400).json({ error: "Invalid or unsupported image." });
    }

    newImageKey = `profile-pictures/${user._id}/${randomUUID()}.webp`;

    try {
      // New image goes up BEFORE Mongo changes — never point the DB at
      // something that hasn't actually landed in the bucket.
      await uploadProfilePicture({ key: newImageKey, body: processedBuffer });
    } catch (err) {
      console.error("Profile image upload failed:", err);
      return res.status(502).json({
        error: "Unable to update profile picture. Please try again.",
      });
    }
  }

  const oldPicture = user.picture;

  if (name) user.name = name;
  if (newImageKey) user.picture = getProfilePictureURL(newImageKey);

  try {
    await user.save();
  } catch (err) {
    // Couldn't persist — clean up the object we just uploaded so it doesn't
    // become an orphan, then report a clean error.
    if (newImageKey) {
      deleteProfilePicture({ key: newImageKey }).catch((cleanupErr) => {
        console.error("Failed to clean up orphaned profile image:", cleanupErr);
      });
    }
    return res.status(400).json({
      error: "Unable to update profile. Please check your details and try again.",
    });
  }

  // Only now that Mongo points at the NEW image do we try to remove the OLD
  // one — and only if it's actually this user's own profile-bucket object
  // (never the default avatar, a Google avatar, or anything else).
  if (newImageKey && isOwnedProfilePictureURL(oldPicture, user._id.toString())) {
    const oldKey = getProfilePictureKeyFromURL(oldPicture);
    deleteProfilePicture({ key: oldKey }).catch((err) => {
      // A failed cleanup must never roll back the DB update or fail the
      // request — the new picture is already live and correct.
      console.error("Failed to delete old profile image:", oldKey, err);
    });
  }

  return res.status(200).json({
    message: "Profile updated successfully.",
    user: {
      id: user._id,
      name: user.name,
      email: user.email,
      picture: user.picture,
      role: user.role,
      hasPassword: !!user.password,
      createdAt: user.createdAt,
      maxStorageInBytes: user.maxStorageInBytes,
      usedStorageInBytes: user.usedStorageInBytes,
    },
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

export const selfSoftDelete = async (req, res) => {

  const user = await User.findById(req.user._id)
  user.isDeleted = true;
  await user.save();

  await deleteUserSessions(user.id);
  return res.json({ message: "Account disabled successfully" })
};

export const selfHardDelete = async (req, res) => {
  const userId = req.user._id;
  const allFiles = await File.find({ userId })
    .select("_id extension")
    .lean();

  const keys = allFiles.map(({ _id, extension }) => ({
    Key: `${_id}${extension}`,
  }));

  if (keys.length) {
    await deleteR2Files(keys);
  }

  // Only remove a CUSTOM uploaded profile image — never the default avatar
  // or a Google-hosted picture, since those don't live in our profile bucket.
  if (isOwnedProfilePictureURL(req.user.picture, userId.toString())) {
    const key = getProfilePictureKeyFromURL(req.user.picture);
    await deleteProfilePicture({ key }).catch((err) => {
      console.error("Failed to delete profile image during self hard-delete:", key, err);
    });
  }

  await Promise.all([
    File.deleteMany({ userId }),
    deleteUserSessions(userId),
    Directory.deleteMany({ userId }),
    User.findByIdAndDelete(userId),
  ]);

  return res.json({ message: "Account deleted successfully" })
};

export const bulkDeleteItems = async (req, res) => {
  const { fileIds = [], directoryIds = [] } = req.body;
  const user = req.user;

  let deletedCount = 0;

  // ---------- FILES ----------
  const files = await File.find({
    _id: { $in: fileIds },
    userId: user._id,
  }).lean();

  if (files.length) {
    const keys = files.map((file) => ({
      Key: `${file._id}${file.extension}`,
    }));

    await Promise.all([
      deleteR2Files(keys),
      File.deleteMany({
        _id: { $in: files.map((f) => f._id) },
      }),
    ]);

    await Promise.all(
      files.map((file) =>
        updateDirectorySize(file.parentDirId, -file.size, user.rootDirId)
      )
    );

    deletedCount += files.length;
  }

  // ---------- DIRECTORIES ----------
  for (const dirId of directoryIds) {
    const directoryData = await Directory.findOne({
      _id: dirId,
      userId: user._id,
    })
      .select("_id size parentDirId")
      .lean();

    if (!directoryData) continue;

    const { files, directories } = await getDirectoryContent(
      directoryData._id
    );

    const keys = files.map((file) => ({
      Key: `${file._id}${file.extension}`,
    }));

    if (keys.length) {
      await deleteR2Files(keys);
    }

    await File.deleteMany({
      _id: { $in: files.map((f) => f._id) },
    });

    await Directory.deleteMany({
      _id: {
        $in: [
          ...directories.map((d) => d._id),
          directoryData._id,
        ],
      },
    });

    await updateDirectorySize(
      directoryData.parentDirId,
      -directoryData.size,
      user.rootDirId
    );

    deletedCount++;
  }

  return res.json({
    message: `${deletedCount} item(s) deleted`,
  });
};
