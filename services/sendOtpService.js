import { randomInt } from 'node:crypto';
import { Resend } from 'resend';
import OTP from '../models/otpModel.js';

const resend = new Resend(process.env.RESEND_KEY);

export async function sendOtpService(email) {

  const otp = randomInt(1000, 10000); // 4 digits, cryptographically secure
  try {

    await OTP.findOneAndUpdate(
      { email },
      { otp, attempts: 0, createdAt: new Date() },
      { upsert: true })


    const html = `
<div style="font-family:Arial,sans-serif;max-width:500px;margin:auto;padding:20px;">
  <h2 style="color:#2563eb;margin-bottom:10px;">
    Hi there,
  </h2>

  <p style="font-size:15px;color:#444;">
    Your verification code is:
  </p>

  <div
    style="
      font-size:28px;
      font-weight:bold;
      letter-spacing:4px;
      color:#2563eb;
      background:#f3f8ff;
      border:1px solid #dbeafe;
      border-radius:8px;
      padding:12px;
      text-align:center;
      margin:16px 0;
    "
  >
    ${otp}
  </div>

  <p style="color:#555;">
    This code is valid for <b>10 minutes</b>.
  </p>

  <p style="color:#777;font-size:13px;">
    If you didn't request this code, you can safely ignore this email.
  </p>

  <br />

  <p style="color:#444;">
    Thanks,<br />
    <b>Team Haadi</b>
  </p>
</div>`;


    await resend.emails.send({
      from: 'Haadi Cloud App <no-reply@mirhaadi.in>',
      to: email,
      subject: 'Your one-time verification code',
      html
    });
    return { success: true, message: "OTP sent successfully" }
  } catch (err) {
    console.log("Error occurred while sending otp: ", err);
    return { success: false, error: "OTP couldn't sent!" }
  }
}
