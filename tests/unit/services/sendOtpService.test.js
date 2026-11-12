import { describe, it, expect, vi, beforeEach } from "vitest";
import { sendOtpService } from "../../../services/sendOtpService.js";
import { OtpMock } from "../../helpers/modelMocks.js";
import { randomInt } from "node:crypto";

const { sendMock } = vi.hoisted(() => ({ sendMock: vi.fn() }));

vi.mock("node:crypto", async (importOriginal) => ({
  ...(await importOriginal()),
  randomInt: vi.fn(),
}));

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
    randomInt.mockReturnValue(5500);
    OtpMock.findOneAndUpdate.mockResolvedValue({});
    sendMock.mockResolvedValue({ id: "msg_1" });

    const result = await sendOtpService("user@example.com");

    expect(result).toEqual({ success: true, message: "OTP sent successfully" });
    expect(OtpMock.findOneAndUpdate).toHaveBeenCalledWith(
      { email: "user@example.com" },
      expect.objectContaining({ otp: 5500, attempts: 0 }),
      { upsert: true },
    );
    const mail = sendMock.mock.calls[0][0];
    expect(mail.to).toBe("user@example.com");
    expect(mail.html).toContain("5500");
  });

  it("draws the OTP from a cryptographically secure 4-digit range (1000-9999)", async () => {
    randomInt.mockReturnValue(1234);
    OtpMock.findOneAndUpdate.mockResolvedValue({});
    sendMock.mockResolvedValue({});

    await sendOtpService("a@b.co");

    expect(randomInt).toHaveBeenCalledWith(1000, 10000); // upper bound is exclusive
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
