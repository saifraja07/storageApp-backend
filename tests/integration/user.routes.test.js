import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import sharp from "sharp";
import { Types } from "mongoose";
import { loadApp, loginAs, loginAsWithDoc, request } from "../helpers/app.js";
import { redisMock } from "../helpers/redisMock.js";
import { UserMock, FileMock, DirectoryMock, SubscriptionMock } from "../helpers/modelMocks.js";
import { query } from "../helpers/query.js";
import { oid, signedSidCookie } from "../helpers/fixtures.js";
import {
  deleteR2Files,
  uploadProfilePicture,
  deleteProfilePicture,
} from "../../services/cloudflareR2Service.js";

// Razorpay is only reached when a deleted account still has a live subscription.
const { rzp } = vi.hoisted(() => ({
  rzp: { subscriptions: { cancel: vi.fn(), fetch: vi.fn() } },
}));
vi.mock("razorpay", () => ({
  default: class {
    constructor() {
      return rzp;
    }
  },
}));

const ROOT = new Types.ObjectId("507f1f77bcf86cd799439011"); // has letters, so UPPERCASE differs
const ROOT_UPPER = ROOT.toString().toUpperCase();

let app;
beforeAll(async () => {
  app = await loadApp();
});

beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  redisMock.ft.search.mockResolvedValue({ total: 0, documents: [] });
  SubscriptionMock.find.mockReturnValue(query([]));
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

  it("signs out every OTHER device after a password change but keeps the current session", async () => {
    const { cookie, user } = loginAsWithDoc({}, {
      password: "hash",
      comparePassword: vi.fn().mockResolvedValue(true),
    });
    redisMock.ft.search.mockResolvedValue({
      total: 3,
      documents: [{ id: "session:test-sid" }, { id: "session:other-1" }, { id: "session:other-2" }],
    });
    await request(app).patch("/users/me/password").set("Cookie", cookie).send(valid).expect(200);
    expect(redisMock.del).toHaveBeenCalledWith("session:other-1", "session:other-2");
    expect(redisMock.del).not.toHaveBeenCalledWith(expect.anything(), expect.anything(), "session:test-sid");
    expect(redisMock.del.mock.calls.flat()).not.toContain("session:test-sid");
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

  describe("hard-delete with a live subscription (H1)", () => {
    const withLiveSub = () => {
      const { cookie, user } = loginAs();
      const subDoc = { _id: oid(), subscriptionId: "sub_live" };
      FileMock.find.mockReturnValue(query([{ _id: oid(), extension: ".pdf" }]));
      SubscriptionMock.find.mockReturnValue(query([subDoc]));
      return { cookie, user, subDoc };
    };

    it("cancels the Razorpay billing BEFORE deleting anything", async () => {
      const { cookie, user, subDoc } = withLiveSub();
      rzp.subscriptions.cancel.mockResolvedValue({});

      await request(app).delete("/users/me").set("Cookie", cookie).expect(200);

      expect(rzp.subscriptions.cancel).toHaveBeenCalledWith("sub_live");
      expect(SubscriptionMock.updateMany).toHaveBeenCalledWith(
        { _id: { $in: [subDoc._id] } },
        expect.objectContaining({ status: "expired" }),
      );
      expect(UserMock.findByIdAndDelete).toHaveBeenCalledWith(user._id);
    });

    it("keeps the account and files if Razorpay refuses to cancel", async () => {
      const { cookie } = withLiveSub();
      rzp.subscriptions.cancel.mockRejectedValue(new Error("rzp down"));
      rzp.subscriptions.fetch.mockResolvedValue({ status: "active" });

      const res = await request(app).delete("/users/me").set("Cookie", cookie).expect(502);

      expect(res.body.error).toMatch(/NOT deleted/);
      expect(deleteR2Files).not.toHaveBeenCalled();
      expect(FileMock.deleteMany).not.toHaveBeenCalled();
      expect(DirectoryMock.deleteMany).not.toHaveBeenCalled();
      expect(UserMock.findByIdAndDelete).not.toHaveBeenCalled();
    });
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
  const claimFrom = (files) =>
    FileMock.findOneAndDelete.mockImplementation(({ _id }) =>
      Promise.resolve(files.find((f) => String(f._id) === String(_id)) ?? null),
    );

  it("deletes only the caller's own files and keeps directory sizes in sync", async () => {
    const { cookie, user } = loginAs();
    const [f1, f2] = [oid(), oid()];
    const parent = oid();
    const files = [
      { _id: f1, extension: ".a", size: 10, parentDirId: parent },
      { _id: f2, extension: ".b", size: 20, parentDirId: parent },
    ];
    FileMock.find.mockReturnValue(query(files));
    claimFrom(files);
    DirectoryMock.findById.mockReturnValue(query({ path: [] }));

    const res = await request(app)
      .post("/users/me/bulk-delete")
      .set("Cookie", cookie)
      .send({ fileIds: [String(f1), String(f2)], directoryIds: [] })
      .expect(200);

    expect(FileMock.find.mock.calls[0][0]).toMatchObject({ userId: user._id });
    expect(deleteR2Files).toHaveBeenCalledWith([{ Key: `${f1}.a` }, { Key: `${f2}.b` }], user._id);
    expect(FileMock.findOneAndDelete).toHaveBeenCalledWith({ _id: f1, userId: user._id });
    expect(FileMock.findOneAndDelete).toHaveBeenCalledWith({ _id: f2, userId: user._id });
    expect(DirectoryMock.updateMany).toHaveBeenCalledTimes(1); // grouped per folder
    expect(DirectoryMock.updateMany).toHaveBeenCalledWith(
      { _id: { $in: [user.rootDirId, parent] } },
      { $inc: { size: -30 } },
    );
    expect(res.body.message).toBe("2 item(s) deleted");
  });

  it.each([["lowercase", (id) => id], ["UPPERCASE", (id) => id.toUpperCase()]])(
    "refuses to bulk-delete the root folder, before deleting anything (%s id)",
    async (_label, asText) => {
      const { cookie } = loginAs({ rootDirId: ROOT });
      const otherFile = oid();
      DirectoryMock.find.mockReturnValue(query([{ _id: ROOT, size: 99, parentDirId: null }]));
      FileMock.find.mockReturnValue(query([{ _id: otherFile, extension: ".a", size: 1, parentDirId: oid() }]));

      const res = await request(app)
        .post("/users/me/bulk-delete")
        .set("Cookie", cookie)
        .send({ fileIds: [String(otherFile)], directoryIds: [asText(ROOT.toString())] })
        .expect(403);

      expect(res.body.error).toMatch(/root folder/);
      expect(deleteR2Files).not.toHaveBeenCalled();
      expect(FileMock.findOneAndDelete).not.toHaveBeenCalled();
      expect(DirectoryMock.findOneAndDelete).not.toHaveBeenCalled();
      expect(DirectoryMock.deleteMany).not.toHaveBeenCalled();
    },
  );

  it("rejects bodies where fileIds / directoryIds are not arrays", async () => {
    const { cookie } = loginAs();
    await request(app).post("/users/me/bulk-delete").set("Cookie", cookie).send({ directoryIds: "abc" }).expect(400);
    await request(app).post("/users/me/bulk-delete").set("Cookie", cookie).send({ fileIds: { $ne: null } }).expect(400);
  });

  it("releases the reservation (not used storage) for unfinished uploads (B4)", async () => {
    const { cookie, user } = loginAs();
    const parent = oid();
    const files = [
      { _id: oid(), extension: ".a", size: 10, parentDirId: parent, isUploading: false },
      { _id: oid(), extension: ".b", size: 40, parentDirId: parent, isUploading: true },
    ];
    FileMock.find.mockReturnValue(query(files));
    claimFrom(files);
    DirectoryMock.findById.mockReturnValue(query({ path: [] }));

    await request(app)
      .post("/users/me/bulk-delete")
      .set("Cookie", cookie)
      .send({ fileIds: files.map((f) => String(f._id)) })
      .expect(200);

    expect(UserMock.updateOne).toHaveBeenCalledWith({ _id: user._id }, { $inc: { reservedStorage: -40 } });
    expect(UserMock.updateOne).toHaveBeenCalledWith({ rootDirId: user.rootDirId }, { $inc: { usedStorageInBytes: -10 } });
    expect(UserMock.updateOne).not.toHaveBeenCalledWith({ rootDirId: user.rootDirId }, { $inc: { usedStorageInBytes: -50 } });
  });

  it("does not release anything twice when a repeated request already removed the files", async () => {
    const { cookie } = loginAs();
    FileMock.find.mockReturnValue(
      query([{ _id: oid(), extension: ".mp4", size: 700, parentDirId: oid(), isUploading: true }]),
    );
    FileMock.findOneAndDelete.mockResolvedValue(null); // another request won the race

    const res = await request(app).post("/users/me/bulk-delete").set("Cookie", cookie).send({ fileIds: ["x"] }).expect(200);

    expect(UserMock.updateOne).not.toHaveBeenCalled();
    expect(DirectoryMock.updateMany).not.toHaveBeenCalled();
    expect(res.body.message).toBe("0 item(s) deleted");
  });

  it("keeps records untouched when the R2 delete fails", async () => {
    const { cookie } = loginAs();
    FileMock.find.mockReturnValue(query([{ _id: oid(), extension: ".a", size: 1, parentDirId: oid() }]));
    deleteR2Files.mockRejectedValue(new Error("R2 down"));
    await request(app).post("/users/me/bulk-delete").set("Cookie", cookie).send({ fileIds: ["x"] }).expect(500);
    expect(FileMock.findOneAndDelete).not.toHaveBeenCalled();
  });

  it("skips directories the caller does not own", async () => {
    const { cookie, user } = loginAs();
    FileMock.find.mockReturnValue(query([]));
    DirectoryMock.find.mockReturnValue(query([])); // nothing owned by the caller matches
    const dirId = String(oid());

    const res = await request(app)
      .post("/users/me/bulk-delete")
      .set("Cookie", cookie)
      .send({ directoryIds: [dirId] })
      .expect(200);

    expect(DirectoryMock.find.mock.calls[0][0]).toEqual({ _id: { $in: [dirId] }, userId: user._id });
    expect(DirectoryMock.deleteMany).not.toHaveBeenCalled();
    expect(res.body.message).toBe("0 item(s) deleted");
  });

  it("deletes an owned directory with everything inside it", async () => {
    const { cookie, user } = loginAs();
    const dir = { _id: oid(), size: 30, parentDirId: oid() };
    const child = oid();
    const innerFile = { _id: oid(), extension: ".txt", size: 30, isUploading: false };
    FileMock.find
      .mockReturnValueOnce(query([])) // files selected directly
      .mockReturnValueOnce(query([innerFile])) // tree listing
      .mockReturnValueOnce(query([innerFile])); // re-read after claiming the folder
    DirectoryMock.find
      .mockReturnValueOnce(query([dir])) // the requested folders
      .mockReturnValueOnce(query([{ _id: child }])); // descendants
    DirectoryMock.findOneAndDelete.mockResolvedValue(dir);
    DirectoryMock.aggregate.mockResolvedValue([{ descendantIds: [child] }]);
    DirectoryMock.findById.mockReturnValue(query({ path: [] }));

    const res = await request(app)
      .post("/users/me/bulk-delete")
      .set("Cookie", cookie)
      .send({ directoryIds: [String(dir._id)] })
      .expect(200);

    expect(deleteR2Files).toHaveBeenCalledWith([{ Key: `${innerFile._id}.txt` }], user._id);
    expect(DirectoryMock.deleteMany).toHaveBeenCalledWith({ _id: { $in: [child] } });
    expect(UserMock.updateOne).toHaveBeenCalledWith(
      { rootDirId: user.rootDirId },
      { $inc: { usedStorageInBytes: -30 } },
    );
    expect(res.body.message).toBe("1 item(s) deleted");
  });

  it("releases the reservation of unfinished uploads inside a deleted folder", async () => {
    const { cookie, user } = loginAs();
    const dir = { _id: oid(), size: 0, parentDirId: oid() };
    const inner = [
      { _id: oid(), extension: ".mp4", size: 700, isUploading: true },
      { _id: oid(), extension: ".mp4", size: 300, isUploading: true },
    ];
    FileMock.find
      .mockReturnValueOnce(query([]))
      .mockReturnValueOnce(query(inner))
      .mockReturnValueOnce(query(inner));
    DirectoryMock.find.mockReturnValueOnce(query([dir])).mockReturnValueOnce(query([]));
    DirectoryMock.findOneAndDelete.mockResolvedValue(dir);
    DirectoryMock.aggregate.mockResolvedValue([{ descendantIds: [] }]);
    DirectoryMock.findById.mockReturnValue(query({ path: [] }));

    await request(app).post("/users/me/bulk-delete").set("Cookie", cookie).send({ directoryIds: [String(dir._id)] }).expect(200);

    expect(UserMock.updateOne).toHaveBeenCalledWith({ _id: user._id }, { $inc: { reservedStorage: -1000 } });
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
