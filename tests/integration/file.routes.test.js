import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import { loadApp, loginAs, request } from "../helpers/app.js";
import { UserMock, FileMock, DirectoryMock } from "../helpers/modelMocks.js";
import { query } from "../helpers/query.js";
import { oid } from "../helpers/fixtures.js";
import {
  createGetSignedUrl,
  createUploadSignedUrl,
  deleteR2File,
  getR2FileMetaData,
} from "../../services/cloudflareR2Service.js";

let app;
beforeAll(async () => {
  app = await loadApp();
});

beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => {});
});

const VALID_ID = "507f1f77bcf86cd799439011";

describe("GET /file/:id", () => {
  it("rejects invalid ids", async () => {
    const { cookie } = loginAs();
    await request(app).get("/file/nope").set("Cookie", cookie).expect(400);
  });

  it("returns 404 when the file is not the caller's", async () => {
    const { cookie, user } = loginAs();
    FileMock.findOne.mockReturnValue(query(null));
    await request(app).get(`/file/${VALID_ID}`).set("Cookie", cookie).expect(404);
    expect(FileMock.findOne).toHaveBeenCalledWith({ _id: VALID_ID, userId: user._id });
    expect(createGetSignedUrl).not.toHaveBeenCalled();
  });

  it("redirects to a signed inline URL", async () => {
    const { cookie, user } = loginAs();
    FileMock.findOne.mockReturnValue(query({ extension: ".pdf", name: "report.pdf" }));
    createGetSignedUrl.mockResolvedValue("https://signed.example/report");

    const res = await request(app).get(`/file/${VALID_ID}`).set("Cookie", cookie).expect(302);

    expect(res.headers.location).toBe("https://signed.example/report");
    expect(createGetSignedUrl).toHaveBeenCalledWith({
      key: `${VALID_ID}.pdf`,
      filename: "report.pdf",
      userId: user._id,
    });
  });

  it("asks for an attachment when ?action=download", async () => {
    const { cookie } = loginAs();
    FileMock.findOne.mockReturnValue(query({ extension: ".pdf", name: "report.pdf" }));
    createGetSignedUrl.mockResolvedValue("https://signed.example/dl");

    await request(app).get(`/file/${VALID_ID}?action=download`).set("Cookie", cookie).expect(302);

    expect(createGetSignedUrl).toHaveBeenCalledWith(expect.objectContaining({ download: true }));
  });
});

describe("PATCH /file/:id (rename)", () => {
  it("validates the new name", async () => {
    const { cookie } = loginAs();
    const res = await request(app).patch(`/file/${VALID_ID}`).set("Cookie", cookie).send({}).expect(400);
    expect(res.body.error).toBeTruthy();
  });

  it("returns 404 for a file that is not the caller's", async () => {
    const { cookie } = loginAs();
    FileMock.findOne.mockResolvedValue(null);
    await request(app).patch(`/file/${VALID_ID}`).set("Cookie", cookie).send({ newFilename: "x.txt" }).expect(404);
  });

  it("renames the file with a sanitised name", async () => {
    const { cookie } = loginAs();
    const file = { name: "old.txt", save: vi.fn().mockResolvedValue(undefined) };
    FileMock.findOne.mockResolvedValue(file);
    await request(app)
      .patch(`/file/${VALID_ID}`)
      .set("Cookie", cookie)
      .send({ newFilename: "<script>x</script>new.txt" })
      .expect(200);
    expect(file.name).toBe("new.txt");
    expect(file.save).toHaveBeenCalledTimes(1);
  });
});

describe("DELETE /file/:id", () => {
  it("returns 404 for a file that is not the caller's", async () => {
    const { cookie } = loginAs();
    FileMock.findOne.mockReturnValue(query(null));
    await request(app).delete(`/file/${VALID_ID}`).set("Cookie", cookie).expect(404);
    expect(deleteR2File).not.toHaveBeenCalled();
  });

  it("removes the record and R2 object and frees the storage", async () => {
    const { cookie, user } = loginAs();
    const parentDirId = oid();
    FileMock.findOne.mockReturnValue(query({ extension: ".png", size: 4096, parentDirId }));
    DirectoryMock.findById.mockReturnValue(query({ path: [] }));
    deleteR2File.mockResolvedValue({});

    await request(app).delete(`/file/${VALID_ID}`).set("Cookie", cookie).expect(200);

    expect(FileMock.findByIdAndDelete).toHaveBeenCalledWith(VALID_ID);
    expect(deleteR2File).toHaveBeenCalledWith({ key: `${VALID_ID}.png`, userId: user._id });
    expect(DirectoryMock.updateMany).toHaveBeenCalledWith(
      { _id: { $in: [user.rootDirId, parentDirId] } },
      { $inc: { size: -4096 } },
    );
    expect(UserMock.updateOne).toHaveBeenCalledWith(
      { rootDirId: user.rootDirId },
      { $inc: { usedStorageInBytes: -4096 } },
    );
  });
});

describe("POST /file/upload/initiate", () => {
  const parentId = oid();
  const initiate = (cookie, body) =>
    request(app).post("/file/upload/initiate").set("Cookie", cookie).send(body);

  it("returns 404 when the target folder is not the caller's", async () => {
    const { cookie } = loginAs();
    DirectoryMock.findOne.mockReturnValue(query(null));
    await initiate(cookie, { parentDirId: String(parentId), name: "a.txt", size: 10 }).expect(404);
    expect(UserMock.findOneAndUpdate).not.toHaveBeenCalled();
  });

  it.each([["abc"], [-1], [undefined]])("rejects an invalid file size (%s)", async (size) => {
    const { cookie, user } = loginAs();
    DirectoryMock.findOne.mockReturnValue(query({ _id: user.rootDirId }));
    const res = await initiate(cookie, { name: "a.txt", size }).expect(400);
    expect(res.body.error).toBe("Invalid filesize!");
  });

  it("returns 507 when the upload would exceed the user's quota", async () => {
    const { cookie, user } = loginAs();
    DirectoryMock.findOne.mockReturnValue(query({ _id: user.rootDirId }));
    UserMock.findOneAndUpdate.mockReturnValue(query(null));
    const res = await initiate(cookie, { name: "huge.bin", size: 10 ** 12 }).expect(507);
    expect(res.body.error).toBe("Not enough storage!");
    expect(FileMock.insertOne).not.toHaveBeenCalled();
  });

  it("reserves storage atomically, creates the file record and returns a signed upload URL", async () => {
    const { cookie, user } = loginAs();
    DirectoryMock.findOne.mockReturnValue(query({ _id: user.rootDirId }));
    UserMock.findOneAndUpdate.mockReturnValue(query(user));
    FileMock.insertOne.mockResolvedValue({ id: "file-123" });
    createUploadSignedUrl.mockResolvedValue("https://signed.example/upload");

    const res = await initiate(cookie, { name: "photo.JPG", size: 2048, contentType: "image/jpeg" }).expect(200);

    expect(res.body).toEqual({ fileId: "file-123", signedUrl: "https://signed.example/upload" });

    const [filter, update] = UserMock.findOneAndUpdate.mock.calls[0];
    expect(filter._id).toBe(user._id);
    expect(filter.$expr).toBeDefined(); // used + reserved + size <= max, checked in the DB
    expect(update).toEqual({ $inc: { reservedStorage: 2048 } });

    expect(FileMock.insertOne).toHaveBeenCalledWith({
      name: "photo.JPG",
      extension: ".JPG",
      size: 2048,
      userId: user._id,
      parentDirId: user.rootDirId,
      isUploading: true,
    });
    expect(createUploadSignedUrl).toHaveBeenCalledWith({
      key: "file-123.JPG",
      contentType: "image/jpeg",
      userId: user._id,
    });
  });

  it("strips directory components from file names (path traversal)", async () => {
    const { cookie, user } = loginAs();
    DirectoryMock.findOne.mockReturnValue(query({ _id: user.rootDirId }));
    UserMock.findOneAndUpdate.mockReturnValue(query(user));
    FileMock.insertOne.mockResolvedValue({ id: "f" });
    createUploadSignedUrl.mockResolvedValue("https://signed.example/u");

    await initiate(cookie, { name: encodeURIComponent("../../etc/passwd.txt"), size: 1 }).expect(200);

    expect(FileMock.insertOne.mock.calls[0][0]).toMatchObject({ name: "passwd.txt", extension: ".txt" });
  });

  it("rolls the reservation and file record back if the signed URL cannot be created", async () => {
    const { cookie, user } = loginAs();
    DirectoryMock.findOne.mockReturnValue(query({ _id: user.rootDirId }));
    UserMock.findOneAndUpdate.mockReturnValue(query(user));
    FileMock.insertOne.mockResolvedValue({ id: "file-9" });
    createUploadSignedUrl.mockRejectedValue(new Error("R2 down"));

    const res = await initiate(cookie, { name: "a.txt", size: 500 }).expect(500);

    expect(res.body.error).toBe("Couldn't generate url!");
    expect(FileMock.deleteOne).toHaveBeenCalledWith({ _id: "file-9" });
    expect(UserMock.updateOne).toHaveBeenCalledWith(
      { _id: user._id },
      { $inc: { reservedStorage: -500 } },
    );
  });
});

describe("POST /file/upload/complete", () => {
  const complete = (cookie, body) =>
    request(app).post("/file/upload/complete").set("Cookie", cookie).send(body);

  const pendingFile = (overrides = {}) => ({
    size: 100,
    extension: ".txt",
    parentDirId: oid(),
    isUploading: true,
    save: vi.fn().mockResolvedValue(undefined),
    deleteOne: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  });

  it("returns 404 for an unknown file", async () => {
    const { cookie } = loginAs();
    FileMock.findOne.mockResolvedValue(null);
    await complete(cookie, { fileId: VALID_ID }).expect(404);
  });

  it("returns 400 when the upload was already completed", async () => {
    const { cookie } = loginAs();
    FileMock.findOne.mockResolvedValue(pendingFile({ isUploading: false }));
    const res = await complete(cookie, { fileId: VALID_ID }).expect(400);
    expect(res.body.error).toBe("Upload already completed");
  });

  it("finalises the upload when the stored size matches the declared size", async () => {
    const { cookie, user } = loginAs();
    const file = pendingFile();
    FileMock.findOne.mockResolvedValue(file);
    getR2FileMetaData.mockResolvedValue({ ContentLength: 100 });
    DirectoryMock.findById.mockReturnValue(query({ path: [] }));

    await complete(cookie, { fileId: VALID_ID }).expect(200);

    expect(file.isUploading).toBe(false);
    expect(file.save).toHaveBeenCalledTimes(1);
    expect(UserMock.updateOne).toHaveBeenCalledWith(
      { _id: user._id },
      { $inc: { reservedStorage: -100 } },
    );
    expect(DirectoryMock.updateMany).toHaveBeenCalledWith(
      expect.anything(),
      { $inc: { size: 100 } },
    );
  });

  it("rejects and cleans up when the uploaded size differs from the reservation", async () => {
    const { cookie, user } = loginAs();
    const file = pendingFile();
    FileMock.findOne.mockResolvedValue(file);
    getR2FileMetaData.mockResolvedValue({ ContentLength: 999 });
    deleteR2File.mockResolvedValue({});

    const res = await complete(cookie, { fileId: VALID_ID }).expect(400);

    expect(res.body.error).toBe("File size does not match!");
    expect(file.deleteOne).toHaveBeenCalledTimes(1);
    expect(deleteR2File).toHaveBeenCalledWith({ key: `${VALID_ID}.txt`, userId: user._id });
    expect(UserMock.updateOne).toHaveBeenCalledWith(
      { _id: user._id },
      { $inc: { reservedStorage: -100 } },
    );
    expect(file.save).not.toHaveBeenCalled();
  });

  it("cleans up when the object is missing in R2", async () => {
    const { cookie } = loginAs();
    const file = pendingFile();
    FileMock.findOne.mockResolvedValue(file);
    getR2FileMetaData.mockRejectedValue(new Error("NotFound"));
    deleteR2File.mockResolvedValue({});

    const res = await complete(cookie, { fileId: VALID_ID }).expect(400);

    expect(res.body.error).toBe("File could not be uploaded properly");
    expect(file.deleteOne).toHaveBeenCalledTimes(1);
  });
});

describe("POST /file/upload/cancel", () => {
  const cancel = (cookie, body) =>
    request(app).post("/file/upload/cancel").set("Cookie", cookie).send(body);

  it("returns 404 when there is no matching unfinished upload", async () => {
    const { cookie, user } = loginAs();
    FileMock.findOneAndDelete.mockReturnValue(query(null));
    await cancel(cookie, { fileId: VALID_ID }).expect(404);
    expect(FileMock.findOneAndDelete).toHaveBeenCalledWith({
      _id: VALID_ID,
      userId: user._id,
      isUploading: true,
    });
  });

  it("deletes the pending file, releases the reservation and removes the R2 object", async () => {
    const { cookie, user } = loginAs();
    FileMock.findOneAndDelete.mockReturnValue(query({ extension: ".mp4", size: 777 }));
    deleteR2File.mockResolvedValue({});

    const res = await cancel(cookie, { fileId: VALID_ID }).expect(200);

    expect(res.body.message).toBe("Upload cancelled");
    expect(UserMock.updateOne).toHaveBeenCalledWith(
      { _id: user._id },
      { $inc: { reservedStorage: -777 } },
    );
    expect(deleteR2File).toHaveBeenCalledWith({ key: `${VALID_ID}.mp4`, userId: user._id });
  });

  it("returns 500 when cleanup fails", async () => {
    const { cookie } = loginAs();
    FileMock.findOneAndDelete.mockReturnValue(query({ extension: ".mp4", size: 1 }));
    deleteR2File.mockRejectedValue(new Error("R2 down"));
    await cancel(cookie, { fileId: VALID_ID }).expect(500);
  });
});
