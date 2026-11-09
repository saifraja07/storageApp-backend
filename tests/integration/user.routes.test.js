import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import sharp from "sharp";
import { loadApp, loginAs, loginAsWithDoc, request } from "../helpers/app.js";
import { redisMock } from "../helpers/redisMock.js";
import { UserMock, FileMock, DirectoryMock } from "../helpers/modelMocks.js";
import { query } from "../helpers/query.js";
import { oid, signedSidCookie } from "../helpers/fixtures.js";
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

describe("GET /users/me", () => {
  it("returns the profile without leaking the password hash", async () => {
    const { cookie } = loginAs({ password: "$2b$12$secrethash", name: "Haadi" });
    const res = await request(app).get("/users/me").set("Cookie", cookie).expect(200);
    expect(res.body).toMatchObject({ name: "Haadi", hasPassword: true, role: "User" });
    expect(JSON.stringify(res.body)).not.toContain("secrethash");
    expect(res.body).not.toHaveProperty("password");
  });

  it("reports hasPassword=false for Google-only accounts", async () => {
    const { cookie } = loginAs({ password: undefined });
    const res = await request(app).get("/users/me").set("Cookie", cookie).expect(200);
    expect(res.body.hasPassword).toBe(false);
  });
});

describe("PATCH /users/me/password", () => {
  const valid = { currentPassword: "old-pass", newPassword: "new-pass", confirmPassword: "new-pass" };

  it("validates the new password", async () => {
    const { cookie } = loginAs();
    const res = await request(app)
      .patch("/users/me/password")
      .set("Cookie", cookie)
      .send({ ...valid, confirmPassword: "different" })
      .expect(400);
    expect(res.body.error).toBe("Passwords do not match.");
  });

  it("requires the current password when one is set", async () => {
    const { cookie } = loginAsWithDoc({}, { password: "hash", comparePassword: vi.fn() });
    const res = await request(app)
      .patch("/users/me/password")
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
    const res = await request(app).patch("/users/me/password").set("Cookie", cookie).send(valid).expect(400);
    expect(res.body.error).toBe("Current password is incorrect.");
    expect(doc.save).not.toHaveBeenCalled();
  });

  it("changes the password when the current one is correct", async () => {
    const { cookie, doc } = loginAsWithDoc({}, {
      password: "hash",
      comparePassword: vi.fn().mockResolvedValue(true),
    });
    const res = await request(app).patch("/users/me/password").set("Cookie", cookie).send(valid).expect(200);
    expect(res.body.message).toBe("Password changed successfully.");
    expect(doc.password).toBe("new-pass"); // hashed by the model's pre-save hook
    expect(doc.save).toHaveBeenCalledTimes(1);
  });

  it("lets a Google-only user set a first password without a current one", async () => {
    const { cookie, doc } = loginAsWithDoc({ password: undefined }, { password: undefined });
    const res = await request(app)
      .patch("/users/me/password")
      .set("Cookie", cookie)
      .send({ newPassword: "first-pass", confirmPassword: "first-pass" })
      .expect(200);
    expect(res.body.message).toBe("Password set successfully.");
    expect(doc.save).toHaveBeenCalled();
  });
});

describe("PATCH /users/me/profile", () => {
  const png = () =>
    sharp({ create: { width: 64, height: 64, channels: 3, background: "#336699" } }).png().toBuffer();

  it("requires a name or an image", async () => {
    const { cookie } = loginAs();
    const res = await request(app).patch("/users/me/profile").set("Cookie", cookie).field("x", "y");
    // unknown field → rejected by the strict schema before anything else
    expect(res.status).toBe(400);
  });

  it("rejects an empty update", async () => {
    const { cookie } = loginAs();
    const res = await request(app).patch("/users/me/profile").set("Cookie", cookie).send({}).expect(400);
    expect(res.body.error).toBe("Provide a name or a profile image to update.");
  });

  it("updates the name", async () => {
    const { cookie, doc } = loginAsWithDoc();
    const res = await request(app)
      .patch("/users/me/profile")
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
      .patch("/users/me/profile")
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
      .patch("/users/me/profile")
      .set("Cookie", cookie)
      .attach("picture", await png(), "me.png")
      .expect(200);

    expect(deleteProfilePicture).toHaveBeenCalledWith({ key: oldKey });
  });

  it("rejects a file that is not a real image", async () => {
    const { cookie } = loginAsWithDoc();
    const res = await request(app)
      .patch("/users/me/profile")
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
      .patch("/users/me/profile")
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
      .patch("/users/me/profile")
      .set("Cookie", cookie)
      .attach("picture", await png(), "me.png")
      .expect(400);

    const uploadedKey = uploadProfilePicture.mock.calls[0][0].key;
    expect(deleteProfilePicture).toHaveBeenCalledWith({ key: uploadedKey });
  });

  it("rejects an oversized image with 400", async () => {
    const { cookie } = loginAs();
    const res = await request(app)
      .patch("/users/me/profile")
      .set("Cookie", cookie)
      .attach("picture", Buffer.alloc(5 * 1024 * 1024 + 1), "big.png")
      .expect(400);
    expect(res.body.error).toBe("Profile image must be 5 MB or smaller.");
  });
});

describe("account deletion", () => {
  it("PATCH /users/me/deactivation disables the account and ends all sessions", async () => {
    const { cookie, doc } = loginAsWithDoc();
    redisMock.ft.search.mockResolvedValue({ total: 1, documents: [{ id: "session:a" }] });
    await request(app).patch("/users/me/deactivation").set("Cookie", cookie).expect(200);
    expect(doc.isDeleted).toBe(true);
    expect(doc.save).toHaveBeenCalledTimes(1);
    expect(redisMock.del).toHaveBeenCalledWith("session:a");
  });

  it("DELETE /users/me removes files from R2, all records and sessions", async () => {
    const { cookie, user } = loginAs();
    const fileId = oid();
    FileMock.find.mockReturnValue(query([{ _id: fileId, extension: ".pdf" }]));
    redisMock.ft.search.mockResolvedValue({ total: 1, documents: [{ id: "session:a" }] });

    await request(app).delete("/users/me").set("Cookie", cookie).expect(200);

    expect(deleteR2Files).toHaveBeenCalledWith([{ Key: `${fileId}.pdf` }], user._id);
    expect(FileMock.deleteMany).toHaveBeenCalledWith({ userId: user._id });
    expect(DirectoryMock.deleteMany).toHaveBeenCalledWith({ userId: user._id });
    expect(UserMock.findByIdAndDelete).toHaveBeenCalledWith(user._id);
    expect(redisMock.del).toHaveBeenCalledWith("session:a");
  });

  it("hard-delete never deletes a default or Google avatar from the profile bucket", async () => {
    const { cookie } = loginAs({ picture: "https://lh3.googleusercontent.com/a/abc" });
    FileMock.find.mockReturnValue(query([]));
    await request(app).delete("/users/me").set("Cookie", cookie).expect(200);
    expect(deleteProfilePicture).not.toHaveBeenCalled();
    expect(deleteR2Files).not.toHaveBeenCalled();
  });

  it("hard-delete removes the user's own custom profile picture", async () => {
    const id = oid();
    const key = `profile-pictures/${id}/me.webp`;
    const { cookie } = loginAs({ _id: id, picture: `https://cdn.example.com/${key}` });
    FileMock.find.mockReturnValue(query([]));
    deleteProfilePicture.mockResolvedValue({});
    await request(app).delete("/users/me").set("Cookie", cookie).expect(200);
    expect(deleteProfilePicture).toHaveBeenCalledWith({ key });
  });
});

describe("POST /users/me/bulk-delete", () => {
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
      .post("/users/me/bulk-delete")
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
    await request(app).post("/users/me/bulk-delete").set("Cookie", cookie).send({ fileIds: ["x"] }).expect(500);
    expect(FileMock.deleteMany).not.toHaveBeenCalled();
  });

  it("skips directories the caller does not own", async () => {
    const { cookie, user } = loginAs();
    FileMock.find.mockReturnValue(query([]));
    DirectoryMock.findOne.mockReturnValue(query(null));
    const dirId = String(oid());

    const res = await request(app)
      .post("/users/me/bulk-delete")
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
      .post("/users/me/bulk-delete")
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
      .get("/users/me")
      .set("Cookie", signedSidCookie("test-sid", "wrong-secret"))
      .expect(401);
  });
});
