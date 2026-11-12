import { describe, it, expect, beforeAll, vi } from "vitest";
import { loadApp, loginAs, request } from "../helpers/app.js";
import { UserMock, FileMock, DirectoryMock } from "../helpers/modelMocks.js";
import { query } from "../helpers/query.js";
import { oid } from "../helpers/fixtures.js";
import { deleteR2Files } from "../../services/cloudflareR2Service.js";

let app;
beforeAll(async () => {
  app = await loadApp();
});

const VALID_ID = "507f1f77bcf86cd799439011";

describe("directory id validation", () => {
  it.each([
    ["get", "/directories/not-an-id"],
    ["get", "/directories/not-an-id/path"],
    ["post", "/directories/not-an-id/children"],
    ["patch", "/directories/not-an-id"],
    ["delete", "/directories/not-an-id"],
  ])("%s %s → 400", async (method, path) => {
    const { cookie } = loginAs();
    const res = await request(app)[method](path).set("Cookie", cookie).send({}).expect(400);
    expect(res.body.error).toMatch(/Invalid Id/);
  });
});

describe("GET /directories/:directoryId?", () => {
  it("defaults to the user's root directory and scopes the lookup to the owner", async () => {
    const { cookie, user } = loginAs();
    const dir = { _id: user.rootDirId, name: "root", userId: user._id };
    DirectoryMock.findOne.mockReturnValue(query(dir));
    FileMock.find.mockReturnValue(query([{ _id: oid(), name: "a.txt" }]));
    DirectoryMock.find.mockReturnValue(query([{ _id: oid(), name: "Docs" }]));

    const res = await request(app).get("/directories").set("Cookie", cookie).expect(200);

    expect(DirectoryMock.findOne).toHaveBeenCalledWith({ _id: user.rootDirId, userId: user._id });
    expect(res.body.files).toHaveLength(1);
    expect(res.body.files[0]).toHaveProperty("id");
    expect(res.body.directories[0].name).toBe("Docs");
  });

  it("returns 404 for a directory the user does not own (or that does not exist)", async () => {
    const { cookie, user } = loginAs();
    DirectoryMock.findOne.mockReturnValue(query(null));
    const res = await request(app).get(`/directories/${VALID_ID}`).set("Cookie", cookie).expect(404);
    expect(res.body.error).toMatch(/not found or you do not have access/i);
    expect(DirectoryMock.findOne).toHaveBeenCalledWith({ _id: VALID_ID, userId: user._id });
    expect(FileMock.find).not.toHaveBeenCalled();
  });
});

describe("GET /directories/:directoryId/path", () => {
  it("returns breadcrumb path and current directory", async () => {
    const { cookie } = loginAs();
    const id = oid();
    DirectoryMock.findOne.mockReturnValue(
      query({ _id: id, name: "Reports", path: [{ _id: oid(), name: "Work" }] }),
    );
    const res = await request(app).get(`/directories/${id}/path`).set("Cookie", cookie).expect(200);
    expect(res.body.current).toEqual({ _id: String(id), name: "Reports" });
    expect(res.body.path).toHaveLength(1);
  });

  it("returns 404 when not found / not owned", async () => {
    const { cookie } = loginAs();
    DirectoryMock.findOne.mockReturnValue(query(null));
    await request(app).get(`/directories/${VALID_ID}/path`).set("Cookie", cookie).expect(404);
  });
});

describe("POST /directories[/:parentDirId/children] (create)", () => {
  it("creates a folder in the root with an empty ancestor path", async () => {
    const { cookie, user } = loginAs();
    DirectoryMock.findOne.mockReturnValue(query({ _id: user.rootDirId, path: [] }));

    await request(app).post("/directories").set("Cookie", cookie).send({ dirname: "Photos" }).expect(200);

    expect(DirectoryMock.create).toHaveBeenCalledWith({
      name: "Photos",
      parentDirId: user.rootDirId,
      userId: user._id,
      path: [],
    });
  });

  it("records the full ancestor path for nested folders", async () => {
    const { cookie, user } = loginAs();
    const [a, parent] = [oid(), oid()];
    DirectoryMock.findOne.mockReturnValue(query({ _id: parent, path: [a] }));

    await request(app).post(`/directories/${parent}/children`).set("Cookie", cookie).send({ dirname: "Deep" }).expect(200);

    expect(DirectoryMock.create).toHaveBeenCalledWith(
      expect.objectContaining({ path: [a, parent], userId: user._id }),
    );
  });

  it("names the folder 'New Folder' when no name is given", async () => {
    const { cookie, user } = loginAs();
    DirectoryMock.findOne.mockReturnValue(query({ _id: user.rootDirId, path: [] }));
    await request(app).post("/directories").set("Cookie", cookie).send({}).expect(200);
    expect(DirectoryMock.create).toHaveBeenCalledWith(expect.objectContaining({ name: "New Folder" }));
  });

  it("strips HTML from the folder name (stored-XSS protection)", async () => {
    const { cookie, user } = loginAs();
    DirectoryMock.findOne.mockReturnValue(query({ _id: user.rootDirId, path: [] }));
    await request(app)
      .post("/directories")
      .set("Cookie", cookie)
      .send({ dirname: "<img src=x onerror=alert(1)>Docs" })
      .expect(200);
    const created = DirectoryMock.create.mock.calls[0][0];
    expect(created.name).toBe("Docs");
  });

  it("rejects over-long names", async () => {
    const { cookie } = loginAs();
    const res = await request(app)
      .post("/directories")
      .set("Cookie", cookie)
      .send({ dirname: "x".repeat(201) })
      .expect(400);
    expect(res.body.error).toBe("Directory name too long");
    expect(DirectoryMock.create).not.toHaveBeenCalled();
  });

  it("refuses to create inside someone else's directory", async () => {
    const { cookie } = loginAs();
    DirectoryMock.findOne.mockReturnValue(query(null));
    const res = await request(app)
      .post(`/directories/${VALID_ID}/children`)
      .set("Cookie", cookie)
      .send({ dirname: "Sneaky" })
      .expect(403);
    expect(res.body.error).toMatch(/access denied/i);
    expect(DirectoryMock.create).not.toHaveBeenCalled();
  });
});

describe("PATCH /directories/:directoryId (rename)", () => {
  it("requires a new name", async () => {
    const { cookie } = loginAs();
    const res = await request(app).patch(`/directories/${VALID_ID}`).set("Cookie", cookie).send({}).expect(400);
    expect(res.body.error).toBeTruthy();
  });

  it("returns 404 for someone else's directory", async () => {
    const { cookie } = loginAs();
    DirectoryMock.findOne.mockResolvedValue(null);
    await request(app)
      .patch(`/directories/${VALID_ID}`)
      .set("Cookie", cookie)
      .send({ newDirName: "X" })
      .expect(404);
  });

  it("renames an owned directory using the sanitised name", async () => {
    const { cookie, user } = loginAs();
    const dir = { name: "Old", save: vi.fn().mockResolvedValue(undefined) };
    DirectoryMock.findOne.mockResolvedValue(dir);

    await request(app)
      .patch(`/directories/${VALID_ID}`)
      .set("Cookie", cookie)
      .send({ newDirName: "<b>New</b> Name" })
      .expect(200);

    expect(DirectoryMock.findOne).toHaveBeenCalledWith({ _id: VALID_ID, userId: user._id });
    expect(dir.name).toBe("New Name");
    expect(dir.save).toHaveBeenCalledTimes(1);
  });
});

describe("DELETE /directories/:directoryId", () => {
  it("returns 404 for someone else's directory", async () => {
    const { cookie } = loginAs();
    DirectoryMock.findOne.mockReturnValue(query(null));
    await request(app).delete(`/directories/${VALID_ID}`).set("Cookie", cookie).expect(404);
    expect(deleteR2Files).not.toHaveBeenCalled();
  });

  it("deletes the folder tree, its R2 objects, and frees the used storage", async () => {
    const { cookie, user } = loginAs();
    const dir = { _id: oid(), size: 500, parentDirId: oid() };
    const child = oid();
    const files = [
      { _id: oid(), extension: ".png" },
      { _id: oid(), extension: ".pdf" },
    ];
    DirectoryMock.findOne.mockReturnValue(query(dir));
    DirectoryMock.aggregate.mockResolvedValue([{ descendantIds: [child] }]);
    FileMock.find.mockReturnValue(query(files));
    DirectoryMock.find.mockReturnValue(query([{ _id: child }]));
    DirectoryMock.findById.mockReturnValue(query({ path: [] }));

    await request(app).delete(`/directories/${dir._id}`).set("Cookie", cookie).expect(200);

    expect(deleteR2Files).toHaveBeenCalledWith(
      [{ Key: `${files[0]._id}.png` }, { Key: `${files[1]._id}.pdf` }],
      user._id,
    );
    expect(FileMock.deleteMany).toHaveBeenCalledWith({ _id: { $in: files.map((f) => f._id) } });
    expect(DirectoryMock.deleteMany).toHaveBeenCalledWith({ _id: { $in: [child, dir._id] } });
    expect(DirectoryMock.updateMany).toHaveBeenCalledWith(
      { _id: { $in: [user.rootDirId, dir.parentDirId] } },
      { $inc: { size: -500 } },
    );
    expect(UserMock.updateOne).toHaveBeenCalledWith(
      { rootDirId: user.rootDirId },
      { $inc: { usedStorageInBytes: -500 } },
    );
  });

  it("releases the reservation held by unfinished uploads inside the folder", async () => {
    const { cookie, user } = loginAs();
    const dir = { _id: oid(), size: 0, parentDirId: oid() };
    const files = [
      { _id: oid(), extension: ".mp4", size: 700, isUploading: true },
      { _id: oid(), extension: ".mp4", size: 300, isUploading: true },
      { _id: oid(), extension: ".png", size: 50, isUploading: false },
    ];
    DirectoryMock.findOne.mockReturnValue(query(dir));
    DirectoryMock.aggregate.mockResolvedValue([{ descendantIds: [] }]);
    FileMock.find.mockReturnValue(query(files));
    DirectoryMock.find.mockReturnValue(query([]));
    DirectoryMock.findById.mockReturnValue(query({ path: [] }));

    await request(app).delete(`/directories/${dir._id}`).set("Cookie", cookie).expect(200);

    expect(UserMock.updateOne).toHaveBeenCalledWith(
      { _id: user._id },
      { $inc: { reservedStorage: -1000 } },
    );
  });

  it("keeps all records when R2 deletion fails", async () => {
    const { cookie } = loginAs();
    const dir = { _id: oid(), size: 1, parentDirId: oid() };
    DirectoryMock.findOne.mockReturnValue(query(dir));
    DirectoryMock.aggregate.mockResolvedValue([{ descendantIds: [] }]);
    FileMock.find.mockReturnValue(query([{ _id: oid(), extension: ".a" }]));
    DirectoryMock.find.mockReturnValue(query([]));
    deleteR2Files.mockRejectedValue(new Error("R2 down"));
    vi.spyOn(console, "error").mockImplementation(() => {});

    await request(app).delete(`/directories/${dir._id}`).set("Cookie", cookie).expect(500);

    expect(FileMock.deleteMany).not.toHaveBeenCalled();
    expect(DirectoryMock.deleteMany).not.toHaveBeenCalled();
  });
});
