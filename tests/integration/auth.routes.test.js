import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import mongoose from "mongoose";
import { loadApp, request, mockMongoSession } from "../helpers/app.js";
import { redisMock } from "../helpers/redisMock.js";
import { UserMock, DirectoryMock, OtpMock } from "../helpers/modelMocks.js";
import { makeUser } from "../helpers/fixtures.js";
import { sendOtpService } from "../../services/sendOtpService.js";
import { getUserFromAuthCode } from "../../services/googleAuthService.js";

let app;
beforeAll(async () => {
  app = await loadApp();
});

beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  redisMock.ft.search.mockResolvedValue({ total: 0, documents: [] });
});

describe("POST /auth/send-otp", () => {
  it("rejects an invalid e-mail address", async () => {
    const res = await request(app).post("/auth/send-otp").send({ email: "nope" }).expect(400);
    expect(res.body.error).toBe("Please enter a valid email.");
    expect(sendOtpService).not.toHaveBeenCalled();
  });

  it("rejects a missing body", async () => {
    await request(app).post("/auth/send-otp").send({}).expect(400);
  });

  it("sends the OTP to the lower-cased address", async () => {
    sendOtpService.mockResolvedValue({ success: true, message: "OTP sent successfully" });
    const res = await request(app).post("/auth/send-otp").send({ email: "User@Example.com" }).expect(200);
    expect(sendOtpService).toHaveBeenCalledWith("user@example.com");
    expect(res.body).toEqual({ success: true, message: "OTP sent successfully" });
  });

  it("reports a delivery failure as 400", async () => {
    sendOtpService.mockResolvedValue({ success: false, error: "OTP couldn't sent!" });
    const res = await request(app).post("/auth/send-otp").send({ email: "a@b.co" }).expect(400);
    expect(res.body.error).toBe("OTP couldn't sent!");
  });
});

describe("POST /auth/verify-otp", () => {
  it("validates the body", async () => {
    await request(app).post("/auth/verify-otp").send({ email: "a@b.co", otp: "12" }).expect(400);
    await request(app).post("/auth/verify-otp").send({ otp: "1234" }).expect(400);
  });

  it("rejects a wrong or expired OTP", async () => {
    OtpMock.findOne.mockResolvedValue(null);
    const res = await request(app)
      .post("/auth/verify-otp")
      .send({ email: "a@b.co", otp: "1234" })
      .expect(400);
    expect(res.body.error).toBe("Invalid or Expired Otp!");
  });

  it("accepts the correct OTP", async () => {
    OtpMock.findOne.mockResolvedValue({ email: "a@b.co", otp: 1234 });
    const res = await request(app)
      .post("/auth/verify-otp")
      .send({ email: "A@B.co", otp: "1234" })
      .expect(200);
    expect(res.body).toEqual({ message: "Otp verified" });
    expect(OtpMock.findOne).toHaveBeenCalledWith({ email: "a@b.co", otp: "1234" });
  });
});

describe("POST /auth/google", () => {
  let session;
  beforeEach(() => {
    session = mockMongoSession(mongoose);
  });

  const google = { name: "Google User", email: "g@example.com", picture: "https://lh3.googleusercontent.com/a/x" };

  it("requires an authorization code", async () => {
    const res = await request(app).post("/auth/google").send({}).expect(400);
    expect(res.body.error).toBe("Authorization code is required");
    expect(session.endSession).toHaveBeenCalled();
  });

  it("returns 400 when Google rejects the code", async () => {
    getUserFromAuthCode.mockResolvedValue({ error: "Google Authentication failed!" });
    const res = await request(app).post("/auth/google").send({ code: "bad" }).expect(400);
    expect(res.body.error).toBe("Google Authentication failed!");
  });

  it("blocks a disabled account", async () => {
    getUserFromAuthCode.mockResolvedValue(google);
    UserMock.findOne.mockResolvedValue({ ...makeUser({ isDeleted: true }), id: "u1" });
    const res = await request(app).post("/auth/google").send({ code: "c" }).expect(403);
    expect(res.body.error).toMatch(/disabled/i);
  });

  it("logs an existing user in and sets a secure, httpOnly, signed session cookie", async () => {
    getUserFromAuthCode.mockResolvedValue(google);
    const existing = makeUser({ email: google.email, accessDevice: 1 });
    UserMock.findOne.mockResolvedValue({ ...existing, id: String(existing._id), save: vi.fn() });

    const res = await request(app).post("/auth/google").send({ code: "c" }).expect(200);

    expect(res.body.message).toBe("User logged in with google");
    const cookie = res.headers["set-cookie"].find((c) => c.startsWith("sid="));
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/Secure/i);
    expect(decodeURIComponent(cookie)).toMatch(/^sid=s:/); // signed
    expect(redisMock.json.set).toHaveBeenCalledTimes(1);
  });

  it("registers a brand new Google user inside a transaction and logs them in", async () => {
    getUserFromAuthCode.mockResolvedValue(google);
    UserMock.findOne.mockResolvedValue(null);

    const res = await request(app).post("/auth/google").send({ code: "c" }).expect(201);

    expect(res.body.message).toBe("User Registered with Google & Logged In");
    expect(DirectoryMock.insertOne).toHaveBeenCalledTimes(1);
    expect(UserMock.insertOne).toHaveBeenCalledWith(
      expect.objectContaining({ email: google.email, name: google.name }),
      { session },
    );
    expect(session.commitTransaction).toHaveBeenCalledTimes(1);
    expect(session.abortTransaction).not.toHaveBeenCalled();
    expect(res.headers["set-cookie"].some((c) => c.startsWith("sid="))).toBe(true);
  });

  it("rolls the transaction back and returns 500 if registration fails", async () => {
    getUserFromAuthCode.mockResolvedValue(google);
    UserMock.findOne.mockResolvedValue(null);
    UserMock.insertOne.mockRejectedValue(new Error("write failed"));

    const res = await request(app).post("/auth/google").send({ code: "c" }).expect(500);

    expect(session.abortTransaction).toHaveBeenCalledTimes(1);
    expect(session.commitTransaction).not.toHaveBeenCalled();
    expect(session.endSession).toHaveBeenCalled();
    expect(res.headers["set-cookie"]).toBeUndefined();
  });
});
