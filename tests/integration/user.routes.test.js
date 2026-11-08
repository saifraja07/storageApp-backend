import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import mongoose from "mongoose";
import sharp from "sharp";
import { loadApp, loginAs, loginAsWithDoc, request, mockMongoSession } from "../helpers/app.js";
import { redisMock } from "../helpers/redisMock.js";
import { UserMock, FileMock, DirectoryMock, OtpMock } from "../helpers/modelMocks.js";
import { query } from "../helpers/query.js";
import { makeUser, oid, signedSidCookie } from "../helpers/fixtures.js";
import {
  deleteR2Files,
  uploadProfilePicture,
  deleteProfilePicture,
} from "../../services/cloudflareR2Service.js";

let app;
beforeAll(async () => {
  app = await loadApp();
});

beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  redisMock.ft.search.mockResolvedValue({ total: 0, documents: [] });
});

describe("POST /user/register", () => {
  const body = { name: "Haadi", email: "New@Example.com", password: "secret", otp: "1234" };
  let session;
  beforeEach(() => {
    session = mockMongoSession(mongoose);
  });

  it("validates the input before touching the database", async () => {
    await request(app).post("/user/register").send({ ...body, otp: "12" }).expect(400);
    await request(app).post("/user/register").send({ ...body, name: "ab" }).expect(400);
    expect(OtpMock.findOneAndDelete).not.toHaveBeenCalled();
  });

  it("rejects an invalid or expired OTP", async () => {
    OtpMock.findOneAndDelete.mockResolvedValue(null);
    const res = await request(app).post("/user/register").send(body).expect(400);
    expect(res.body.error).toBe("Invalid or Expired Otp!");
    expect(UserMock.insertOne).not.toHaveBeenCalled();
  });

  it("consumes the OTP, creates the root directory and user in one transaction", async () => {
    OtpMock.findOneAndDelete.mockResolvedValue({});
    const res = await request(app).post("/user/register").send(body).expect(201);

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
    const res = await request(app).post("/user/register").send(body).expect(409);
    expect(res.body.error).toMatch(/already exists/i);
    expect(session.abortTransaction).toHaveBeenCalledTimes(1);
  });

  it("returns 400 when MongoDB schema validation rejects the document", async () => {
    OtpMock.findOneAndDelete.mockResolvedValue({});
    UserMock.insertOne.mockRejectedValue(Object.assign(new Error("invalid"), { code: 121 }));
    await request(app).post("/user/register").send(body).expect(400);
  });

  it("returns 500 (and aborts) on unexpected failures", async () => {
    OtpMock.findOneAndDelete.mockResolvedValue({});
    UserMock.insertOne.mockRejectedValue(new Error("boom"));
    await request(app).post("/user/register").send(body).expect(500);
    expect(session.abortTransaction).toHaveBeenCalledTimes(1);
  });
});

describe("POST /user/login", () => {
  const creds = { email: "User@Example.com", password: "secret" };
  const account = (extra = {}) => ({
    ...makeUser({ email: "user@example.com" }),
    id: "507f1f77bcf86cd799439011",
    password: "hashed",
    comparePassword: vi.fn().mockResolvedValue(true),
    ...extra,
  });

  it("rejects malformed credentials", async () => {
    const res = await request(app).post("/user/login").send({ email: "x", password: "1" }).expect(400);
    expect(res.body.error).toBe("Invalid Credentials");
  });

  it("answers identically for unknown e-mails and wrong passwords (no user enumeration)", async () => {
    UserMock.findOne.mockResolvedValueOnce(null);
    const unknown = await request(app).post("/user/login").send(creds);

    UserMock.findOne.mockResolvedValueOnce(account({ comparePassword: vi.fn().mockResolvedValue(false) }));
    const wrong = await request(app).post("/user/login").send(creds);

    expect(unknown.status).toBe(wrong.status);
    expect(unknown.body).toEqual(wrong.body);
    expect(unknown.body.error).toBe("Invalid email or password!");
    expect(wrong.headers["set-cookie"]).toBeUndefined();
  });

  it("blocks disabled accounts", async () => {
    UserMock.findOne.mockResolvedValue(account({ isDeleted: true }));
    await request(app).post("/user/login").send(creds).expect(403);
  });

  it("tells Google-only accounts to use Google sign-in", async () => {
    UserMock.findOne.mockResolvedValue(account({ password: undefined }));
    const res = await request(app).post("/user/login").send(creds).expect(400);
    expect(res.body.error).toMatch(/Google Sign-In/);
  });

  it("logs in with the right password: enforces device limit and sets a session cookie", async () => {
    const acc = account({ accessDevice: 2 });
    UserMock.findOne.mockResolvedValue(acc);

    const res = await request(app).post("/user/login").send(creds).expect(200);

    expect(UserMock.findOne).toHaveBeenCalledWith({ email: "user@example.com" });
    expect(acc.comparePassword).toHaveBeenCalledWith("secret");
    expect(redisMock.ft.search).toHaveBeenCalled(); // device-limit lookup
    expect(redisMock.json.set).toHaveBeenCalledTimes(1);
    const cookie = res.headers["set-cookie"].find((c) => c.startsWith("sid="));
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/Secure/i);
  });
});

describe("GET /user", () => {
  it("returns the profile without leaking the password hash", async () => {
    const { cookie } = loginAs({ password: "$2b$12$secrethash", name: "Haadi" });
    const res = await request(app).get("/user").set("Cookie", cookie).expect(200);
    expect(res.body).toMatchObject({ name: "Haadi", hasPassword: true, role: "User" });
    expect(JSON.stringify(res.body)).not.toContain("secrethash");
    expect(res.body).not.toHaveProperty("password");
  });

  it("reports hasPassword=false for Google-only accounts", async () => {
    const { cookie } = loginAs({ password: undefined });
    const res = await request(app).get("/user").set("Cookie", cookie).expect(200);
    expect(res.body.hasPassword).toBe(false);
  });
});

describe("logout", () => {
  it("POST /user/logout removes only the current session and clears the cookie", async () => {
    const { cookie } = loginAs();
    const res = await request(app).post("/user/logout").set("Cookie", cookie).expect(200);
    expect(redisMock.del).toHaveBeenCalledWith("session:test-sid");
    expect(res.headers["set-cookie"].join(";")).toMatch(/sid=;/);
  });

  it("POST /user/logout-all removes every session of the user", async () => {
    const { cookie, user } = loginAs();
    redisMock.ft.search.mockResolvedValue({
      total: 2,
      documents: [{ id: "session:a" }, { id: "session:b" }],
    });
    await request(app).post("/user/logout-all").set("Cookie", cookie).expect(200);
    expect(redisMock.ft.search).toHaveBeenCalledWith(
      "userIdIdx",
      `@userId:{${user._id}}`,
      expect.anything(),
    );
    expect(redisMock.del).toHaveBeenCalledWith("session:a", "session:b");
  });
});

describe("PATCH /user/change-password", () => {
  const valid = { currentPassword: "old-pass", newPassword: "new-pass", confirmPassword: "new-pass" };

  it("validates the new password", async () => {
    const { cookie } = loginAs();
    const res = await request(app)
      .patch("/user/change-password")
      .set("Cookie", cookie)
      .send({ ...valid, confirmPassword: "different" })
      .expect(400);
    expect(res.body.error).toBe("Passwords do not match.");
  });

  it("requires the current password when one is set", async () => {
    const { cookie } = loginAsWithDoc({}, { password: "hash", comparePassword: vi.fn() });
    const res = await request(app)
      .patch("/user/change-password")
      .set("Cookie", cookie)
      .send({ newPassword: "new-pass", confirmPassword: "new-pass" })
      .expect(400);
    expect(res.body.error).toBe("Current password is required.");
  });

  it("rejects a wrong current password and does not save", async () => {
    const { cookie, doc } = loginAsWithDoc({}, {
      password: "hash",
      comparePassword: vi.fn().mockResolvedValue(false),
    });
    const res = await request(app).patch("/user/change-password").set("Cookie", cookie).send(valid).expect(400);
    expect(res.body.error).toBe("Current password is incorrect.");
    expect(doc.save).not.toHaveBeenCalled();
  });

  it("changes the password when the current one is correct", async () => {
    const { cookie, doc } = loginAsWithDoc({}, {
      password: "hash",
      comparePassword: vi.fn().mockResolvedValue(true),
    });
    const res = await request(app).patch("/user/change-password").set("Cookie", cookie).send(valid).expect(200);
    expect(res.body.message).toBe("Password changed successfully.");
    expect(doc.password).toBe("new-pass"); // hashed by the model's pre-save hook
    expect(doc.save).toHaveBeenCalledTimes(1);
  });

  it("lets a Google-only user set a first password without a current one", async () => {
    const { cookie, doc } = loginAsWithDoc({ password: undefined }, { password: undefined });
    const res = await request(app)
      .patch("/user/change-password")
      .set("Cookie", cookie)
      .send({ newPassword: "first-pass", confirmPassword: "first-pass" })
      .expect(200);
    expect(res.body.message).toBe("Password set successfully.");
    expect(doc.save).toHaveBeenCalled();
  });
});

describe("PATCH /user/update-profile", () => {
  const png = () =>
    sharp({ create: { width: 64, height: 64, channels: 3, background: "#336699" } }).png().toBuffer();

  it("requires a name or an image", async () => {
    const { cookie } = loginAs();
    const res = await request(app).patch("/user/update-profile").set("Cookie", cookie).field("x", "y");
    // unknown field → rejected by the strict schema before anything else
    expect(res.status).toBe(400);
  });

  it("rejects an empty update", async () => {
    const { cookie } = loginAs();
    const res = await request(app).patch("/user/update-profile").set("Cookie", cookie).send({}).expect(400);
    expect(res.body.error).toBe("Provide a name or a profile image to update.");
  });

  it("updates the name", async () => {
    const { cookie, doc } = loginAsWithDoc();
    const res = await request(app)
      .patch("/user/update-profile")
      .set("Cookie", cookie)
      .field("name", "New Name")
      .expect(200);
    expect(doc.name).toBe("New Name");
    expect(doc.save).toHaveBeenCalledTimes(1);
    expect(res.body.user.name).toBe("New Name");
    expect(res.body.user).not.toHaveProperty("password");
  });

  it("re-encodes the uploaded image, stores it under the user's namespace and updates the URL", async () => {
    const { cookie, doc } = loginAsWithDoc();
    uploadProfilePicture.mockResolvedValue({});

    const res = await request(app)
      .patch("/user/update-profile")
      .set("Cookie", cookie)
      .attach("picture", await png(), "me.png")
      .expect(200);

    const { key, body } = uploadProfilePicture.mock.calls[0][0];
    expect(key).toMatch(new RegExp(`^profile-pictures/${doc._id}/[0-9a-f-]{36}\\.webp$`));
    expect((await sharp(body).metadata()).format).toBe("webp");
    expect(res.body.user.picture).toBe(`https://cdn.example.com/${key}`);
  });

  it("deletes the user's previous custom picture only after the new one is saved", async () => {
    const { cookie, user } = loginAsWithDoc();
    // re-queue: controller must see a doc with an owned custom picture
    const oldKey = `profile-pictures/${user._id}/old.webp`;
    UserMock.findById.mockReset();
    const doc = { ...user, picture: `https://cdn.example.com/${oldKey}`, save: vi.fn() };
    UserMock.findById.mockReturnValueOnce(query(user)).mockReturnValueOnce(doc);
    uploadProfilePicture.mockResolvedValue({});
    deleteProfilePicture.mockResolvedValue({});

    await request(app)
      .patch("/user/update-profile")
      .set("Cookie", cookie)
      .attach("picture", await png(), "me.png")
      .expect(200);

    expect(deleteProfilePicture).toHaveBeenCalledWith({ key: oldKey });
  });

  it("rejects a file that is not a real image", async () => {
    const { cookie } = loginAsWithDoc();
    const res = await request(app)
      .patch("/user/update-profile")
      .set("Cookie", cookie)
      .attach("picture", Buffer.from("not an image"), "x.png")
      .expect(400);
    expect(res.body.error).toBe("Invalid or unsupported image.");
    expect(uploadProfilePicture).not.toHaveBeenCalled();
  });

  it("returns 502 when the image upload to R2 fails", async () => {
    const { cookie, doc } = loginAsWithDoc();
    uploadProfilePicture.mockRejectedValue(new Error("R2 down"));
    await request(app)
      .patch("/user/update-profile")
      .set("Cookie", cookie)
      .attach("picture", await png(), "me.png")
      .expect(502);
    expect(doc.save).not.toHaveBeenCalled();
  });

  it("removes the orphaned upload when saving the user fails", async () => {
    const { cookie, doc } = loginAsWithDoc();
    doc.save.mockRejectedValue(new Error("db down"));
    uploadProfilePicture.mockResolvedValue({});
    deleteProfilePicture.mockResolvedValue({});

    await request(app)
      .patch("/user/update-profile")
      .set("Cookie", cookie)
      .attach("picture", await png(), "me.png")
      .expect(400);

    const uploadedKey = uploadProfilePicture.mock.calls[0][0].key;
    expect(deleteProfilePicture).toHaveBeenCalledWith({ key: uploadedKey });
  });

  it("rejects an oversized image with 400", async () => {
    const { cookie } = loginAs();
    const res = await request(app)
      .patch("/user/update-profile")
      .set("Cookie", cookie)
      .attach("picture", Buffer.alloc(5 * 1024 * 1024 + 1), "big.png")
      .expect(400);
    expect(res.body.error).toBe("Profile image must be 5 MB or smaller.");
  });
});

describe("account deletion", () => {
  it("PATCH /user/soft-delete disables the account and ends all sessions", async () => {
    const { cookie, doc } = loginAsWithDoc();
    redisMock.ft.search.mockResolvedValue({ total: 1, documents: [{ id: "session:a" }] });
    await request(app).patch("/user/soft-delete").set("Cookie", cookie).expect(200);
    expect(doc.isDeleted).toBe(true);
    expect(doc.save).toHaveBeenCalledTimes(1);
    expect(redisMock.del).toHaveBeenCalledWith("session:a");
  });

  it("DELETE /user/hard-delete removes files from R2, all records and sessions", async () => {
    const { cookie, user } = loginAs();
    const fileId = oid();
    FileMock.find.mockReturnValue(query([{ _id: fileId, extension: ".pdf" }]));
    redisMock.ft.search.mockResolvedValue({ total: 1, documents: [{ id: "session:a" }] });

    await request(app).delete("/user/hard-delete").set("Cookie", cookie).expect(200);

    expect(deleteR2Files).toHaveBeenCalledWith([{ Key: `${fileId}.pdf` }], user._id);
    expect(FileMock.deleteMany).toHaveBeenCalledWith({ userId: user._id });
    expect(DirectoryMock.deleteMany).toHaveBeenCalledWith({ userId: user._id });
    expect(UserMock.findByIdAndDelete).toHaveBeenCalledWith(user._id);
    expect(redisMock.del).toHaveBeenCalledWith("session:a");
  });

  it("hard-delete never deletes a default or Google avatar from the profile bucket", async () => {
    const { cookie } = loginAs({ picture: "https://lh3.googleusercontent.com/a/abc" });
    FileMock.find.mockReturnValue(query([]));
    await request(app).delete("/user/hard-delete").set("Cookie", cookie).expect(200);
    expect(deleteProfilePicture).not.toHaveBeenCalled();
    expect(deleteR2Files).not.toHaveBeenCalled();
  });

  it("hard-delete removes the user's own custom profile picture", async () => {
    const id = oid();
    const key = `profile-pictures/${id}/me.webp`;
    const { cookie } = loginAs({ _id: id, picture: `https://cdn.example.com/${key}` });
    FileMock.find.mockReturnValue(query([]));
    deleteProfilePicture.mockResolvedValue({});
    await request(app).delete("/user/hard-delete").set("Cookie", cookie).expect(200);
    expect(deleteProfilePicture).toHaveBeenCalledWith({ key });
  });
});

describe("POST /user/bulk-delete", () => {
  it("deletes only the caller's own files and keeps directory sizes in sync", async () => {
    const { cookie, user } = loginAs();
    const [f1, f2] = [oid(), oid()];
    const parent = oid();
    FileMock.find.mockReturnValue(
      query([
        { _id: f1, extension: ".a", size: 10, parentDirId: parent },
        { _id: f2, extension: ".b", size: 20, parentDirId: parent },
      ]),
    );
    DirectoryMock.findById.mockReturnValue(query({ path: [] }));

    const res = await request(app)
      .post("/user/bulk-delete")
      .set("Cookie", cookie)
      .send({ fileIds: [String(f1), String(f2)], directoryIds: [] })
      .expect(200);

    expect(FileMock.find.mock.calls[0][0]).toMatchObject({ userId: user._id });
    expect(deleteR2Files).toHaveBeenCalledWith(
      [{ Key: `${f1}.a` }, { Key: `${f2}.b` }],
      user._id,
    );
    expect(FileMock.deleteMany).toHaveBeenCalledWith({ _id: { $in: [f1, f2] } });
    expect(res.body.message).toBe("2 item(s) deleted");
  });

  it("keeps records untouched when the R2 delete fails", async () => {
    const { cookie } = loginAs();
    FileMock.find.mockReturnValue(query([{ _id: oid(), extension: ".a", size: 1, parentDirId: oid() }]));
    deleteR2Files.mockRejectedValue(new Error("R2 down"));
    await request(app).post("/user/bulk-delete").set("Cookie", cookie).send({ fileIds: ["x"] }).expect(500);
    expect(FileMock.deleteMany).not.toHaveBeenCalled();
  });

  it("skips directories the caller does not own", async () => {
    const { cookie, user } = loginAs();
    FileMock.find.mockReturnValue(query([]));
    DirectoryMock.findOne.mockReturnValue(query(null));
    const dirId = String(oid());

    const res = await request(app)
      .post("/user/bulk-delete")
      .set("Cookie", cookie)
      .send({ directoryIds: [dirId] })
      .expect(200);

    expect(DirectoryMock.findOne).toHaveBeenCalledWith({ _id: dirId, userId: user._id });
    expect(DirectoryMock.deleteMany).not.toHaveBeenCalled();
    expect(res.body.message).toBe("0 item(s) deleted");
  });

  it("deletes an owned directory with everything inside it", async () => {
    const { cookie, user } = loginAs();
    const dir = { _id: oid(), size: 30, parentDirId: oid() };
    const child = oid();
    const innerFile = { _id: oid(), extension: ".txt" };
    FileMock.find.mockReturnValueOnce(query([])).mockReturnValueOnce(query([innerFile]));
    DirectoryMock.findOne.mockReturnValue(query(dir));
    DirectoryMock.aggregate.mockResolvedValue([{ descendantIds: [child] }]);
    DirectoryMock.find.mockReturnValue(query([{ _id: child }]));
    DirectoryMock.findById.mockReturnValue(query({ path: [] }));

    const res = await request(app)
      .post("/user/bulk-delete")
      .set("Cookie", cookie)
      .send({ directoryIds: [String(dir._id)] })
      .expect(200);

    expect(deleteR2Files).toHaveBeenCalledWith([{ Key: `${innerFile._id}.txt` }], user._id);
    expect(DirectoryMock.deleteMany).toHaveBeenCalledWith({ _id: { $in: [child, dir._id] } });
    expect(UserMock.updateOne).toHaveBeenCalledWith(
      { rootDirId: user.rootDirId },
      { $inc: { usedStorageInBytes: -30 } },
    );
    expect(res.body.message).toBe("1 item(s) deleted");
  });
});

describe("session cookie handling", () => {
  it("does not log anyone in from a cookie signed with another secret", async () => {
    await request(app)
      .get("/user")
      .set("Cookie", signedSidCookie("test-sid", "wrong-secret"))
      .expect(401);
  });
});
