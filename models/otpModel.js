import { model, Schema } from "mongoose";

const OtpSchema = new Schema(
    {
        email: {
            type: String,
            required: true,
            unique: true,
        },
        otp: {
            type: Number,
            required: true,
        },
        attempts: {
            type: Number,
            default: 0,
        },
        createdAt: {
            type: Date,
            default: Date.now,
            expires: 600,
        },
    },
    {
        strict: "throw",
        versionKey: false
    },
);

const OTP = model("OTP", OtpSchema);

export default OTP;
