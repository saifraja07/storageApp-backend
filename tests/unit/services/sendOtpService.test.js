import { describe, it, expect, vi, beforeEach } from "vitest";
import { sendOtpService } from "../../../services/sendOtpService.js";
import { OtpMock } from "../../helpers/modelMocks.js";

const { sendMock } = vi.hoisted(() => ({ sendMock: vi.fn() }));

vi.mock("resend", () => ({
  Resend: class {
    emails = { send: sendMock };
  },
}));
vi.mock("../../../models/otpModel.js", async () => ({
  default: (await import("../../helpers/modelMocks.js")).OtpMock,
}));

beforeEach(() => {
  vi.spyOn(console, "log").mockImplementation(() => {});
});

describe("sendOtpService", () => {
  it("stores a 4-digit OTP for the email and e-mails it", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0.5); // 1000 + 0.5 * 9000 = 5500
    OtpMock.findOneAndUpdate.mockResolvedValue({});
    sendMock.mockResolvedValue({ id: "msg_1" });

    const result = await sendOtpService("user@example.com");

    expect(result).toEqual({ success: true, message: "OTP sent successfully" });
    expect(OtpMock.findOneAndUpdate).toHaveBeenCalledWith(
      { email: "user@example.com" },
      expect.objectContaining({ otp: 5500 }),
      { upsert: true },
    );
    const mail = sendMock.mock.calls[0][0];
    expect(mail.to).toBe("user@example.com");
    expect(mail.html).toContain("5500");
  });

  it("always generates an OTP between 1000 and 9999", async () => {
    OtpMock.findOneAndUpdate.mockResolvedValue({});
    sendMock.mockResolvedValue({});
    for (const r of [0, 0.999999]) {
      vi.spyOn(Math, "random").mockReturnValue(r);
      await sendOtpService("a@b.co");
    }
    const otps = OtpMock.findOneAndUpdate.mock.calls.map(([, update]) => update.otp);
    expect(otps).toEqual([1000, 9999]);
  });

  it("returns a failure result (does not throw) when e-mail delivery fails", async () => {
    OtpMock.findOneAndUpdate.mockResolvedValue({});
    sendMock.mockRejectedValue(new Error("resend down"));
    const result = await sendOtpService("user@example.com");
    expect(result).toEqual({ success: false, error: "OTP couldn't sent!" });
  });

  it("returns a failure result when the OTP cannot be stored, without e-mailing", async () => {
    OtpMock.findOneAndUpdate.mockRejectedValue(new Error("db down"));
    const result = await sendOtpService("user@example.com");
    expect(result.success).toBe(false);
    expect(sendMock).not.toHaveBeenCalled();
  });
});
