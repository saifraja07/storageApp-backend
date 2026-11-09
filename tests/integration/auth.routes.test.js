import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import mongoose from "mongoose";
import { loadApp, loginAs, request, mockMongoSession } from "../helpers/app.js";
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

describe("POST /auth/otp/send", () => {
  it("rejects an invalid e-mail address", async () => {
    const res = await request(app).post("/auth/otp/send").send({ email: "nope" }).expect(400);
    expect(res.body.error).toBe("Please enter a valid email.");
    expect(sendOtpService).not.toHaveBeenCalled();
  });

  it("rejects a missing body", async () => {
    await request(app).post("/auth/otp/send").send({}).expect(400);
  });

  it("sends the OTP to the lower-cased address", async () => {
    sendOtpService.mockResolvedValue({ success: true, message: "OTP sent successfully" });
    const res = await request(app).post("/auth/otp/send").send({ email: "User@Example.com" }).expect(200);
    expect(sendOtpService).toHaveBeenCalledWith("user@example.com");
    expect(res.body).toEqual({ success: true, message: "OTP sent successfully" });
  });

  it("reports a delivery failure as 400", async () => {
    sendOtpService.mockResolvedValue({ success: false, error: "OTP couldn't sent!" });
    const res = await request(app).post("/auth/otp/send").send({ email: "a@b.co" }).expect(400);
    expect(res.body.error).toBe("OTP couldn't sent!");
  });
});

describe("POST /auth/otp/verify", () => {
  it("validates the body", async () => {
    await request(app).post("/auth/otp/verify").send({ email: "a@b.co", otp: "12" }).expect(400);
    await request(app).post("/auth/otp/verify").send({ otp: "1234" }).expect(400);
  });

  it("rejects a wrong or expired OTP", async () => {
    OtpMock.findOne.mockResolvedValue(null);
    const res = await request(app)
      .post("/auth/otp/verify")
      .send({ email: "a@b.co", otp: "1234" })
      .expect(400);
    expect(res.body.error).toBe("Invalid or Expired Otp!");
  });

  it("accepts the correct OTP", async () => {
    OtpMock.findOne.mockResolvedValue({ email: "a@b.co", otp: 1234 });
    const res = await request(app)
      .post("/auth/otp/verify")
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

describe("POST /auth/register", () => {
  const body = { name: "Haadi", email: "New@Example.com", password: "secret", otp: "1234" };
  let session;
  beforeEach(() => {
    session = mockMongoSession(mongoose);
  });

  it("validates the input before touching the database", async () => {
    await request(app).post("/auth/register").send({ ...body, otp: "12" }).expect(400);
    await request(app).post("/auth/register").send({ ...body, name: "ab" }).expect(400);
    expect(OtpMock.findOneAndDelete).not.toHaveBeenCalled();
  });

  it("rejects an invalid or expired OTP", async () => {
    OtpMock.findOneAndDelete.mockResolvedValue(null);
    const res = await request(app).post("/auth/register").send(body).expect(400);
    expect(res.body.error).toBe("Invalid or Expired Otp!");
    expect(UserMock.insertOne).not.toHaveBeenCalled();
  });

  it("consumes the OTP, creates the root directory and user in one transaction", async () => {
    OtpMock.findOneAndDelete.mockResolvedValue({});
    const res = await request(app).post("/auth/register").send(body).expect(201);

    expect(res.body.message).toBe("User Registered!");
    expect(OtpMock.findOneAndDelete).toHaveBeenCalledWith({ email: "new@example.com", otp: "1234" });
    expect(DirectoryMock.insertOne).toHaveBeenCalledWith(
      expect.objectContaining({ name: "root-new@example.com", parentDirId: null }),
      { session },
    );
    expect(UserMock.insertOne).toHaveBeenCalledWith(
      expect.objectContaining({ name: "Haadi", email: "new@example.com", password: "secret" }),
      { session },
    );
    expect(session.commitTransaction).toHaveBeenCalledTimes(1);
    expect(session.endSession).toHaveBeenCalledTimes(1);
  });

  it("returns 409 for an e-mail that is already registered", async () => {
    OtpMock.findOneAndDelete.mockResolvedValue({});
    UserMock.insertOne.mockRejectedValue(Object.assign(new Error("dup"), { code: 11000 }));
    const res = await request(app).post("/auth/register").send(body).expect(409);
    expect(res.body.error).toMatch(/already exists/i);
    expect(session.abortTransaction).toHaveBeenCalledTimes(1);
  });

  it("returns 400 when MongoDB schema validation rejects the document", async () => {
    OtpMock.findOneAndDelete.mockResolvedValue({});
    UserMock.insertOne.mockRejectedValue(Object.assign(new Error("invalid"), { code: 121 }));
    await request(app).post("/auth/register").send(body).expect(400);
  });

  it("returns 500 (and aborts) on unexpected failures", async () => {
    OtpMock.findOneAndDelete.mockResolvedValue({});
    UserMock.insertOne.mockRejectedValue(new Error("boom"));
    await request(app).post("/auth/register").send(body).expect(500);
    expect(session.abortTransaction).toHaveBeenCalledTimes(1);
  });
});

describe("POST /auth/login", () => {
  const creds = { email: "User@Example.com", password: "secret" };
  const account = (extra = {}) => ({
    ...makeUser({ email: "user@example.com" }),
    id: "507f1f77bcf86cd799439011",
    password: "hashed",
    comparePassword: vi.fn().mockResolvedValue(true),
    ...extra,
  });

  it("rejects malformed credentials", async () => {
    const res = await request(app).post("/auth/login").send({ email: "x", password: "1" }).expect(400);
    expect(res.body.error).toBe("Invalid Credentials");
  });

  it("answers identically for unknown e-mails and wrong passwords (no user enumeration)", async () => {
    UserMock.findOne.mockResolvedValueOnce(null);
    const unknown = await request(app).post("/auth/login").send(creds);

    UserMock.findOne.mockResolvedValueOnce(account({ comparePassword: vi.fn().mockResolvedValue(false) }));
    const wrong = await request(app).post("/auth/login").send(creds);

    expect(unknown.status).toBe(wrong.status);
    expect(unknown.body).toEqual(wrong.body);
    expect(unknown.body.error).toBe("Invalid email or password!");
    expect(wrong.headers["set-cookie"]).toBeUndefined();
  });

  it("blocks disabled accounts", async () => {
    UserMock.findOne.mockResolvedValue(account({ isDeleted: true }));
    await request(app).post("/auth/login").send(creds).expect(403);
  });

  it("tells Google-only accounts to use Google sign-in", async () => {
    UserMock.findOne.mockResolvedValue(account({ password: undefined }));
    const res = await request(app).post("/auth/login").send(creds).expect(400);
    expect(res.body.error).toMatch(/Google Sign-In/);
  });

  it("logs in with the right password: enforces device limit and sets a session cookie", async () => {
    const acc = account({ accessDevice: 2 });
    UserMock.findOne.mockResolvedValue(acc);

    const res = await request(app).post("/auth/login").send(creds).expect(200);

    expect(UserMock.findOne).toHaveBeenCalledWith({ email: "user@example.com" });
    expect(acc.comparePassword).toHaveBeenCalledWith("secret");
    expect(redisMock.ft.search).toHaveBeenCalled(); // device-limit lookup
    expect(redisMock.json.set).toHaveBeenCalledTimes(1);
    const cookie = res.headers["set-cookie"].find((c) => c.startsWith("sid="));
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/Secure/i);
  });
});

describe("logout", () => {
  it("POST /auth/logout removes only the current session and clears the cookie", async () => {
    const { cookie } = loginAs();
    const res = await request(app).post("/auth/logout").set("Cookie", cookie).expect(200);
    expect(redisMock.del).toHaveBeenCalledWith("session:test-sid");
    expect(res.headers["set-cookie"].join(";")).toMatch(/sid=;/);
  });

  it("POST /auth/logout-all removes every session of the user", async () => {
    const { cookie, user } = loginAs();
    redisMock.ft.search.mockResolvedValue({
      total: 2,
      documents: [{ id: "session:a" }, { id: "session:b" }],
    });
    await request(app).post("/auth/logout-all").set("Cookie", cookie).expect(200);
    expect(redisMock.ft.search).toHaveBeenCalledWith(
      "userIdIdx",
      `@userId:{${user._id}}`,
      expect.anything(),
    );
    expect(redisMock.del).toHaveBeenCalledWith("session:a", "session:b");
  });
});
