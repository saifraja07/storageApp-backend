import { describe, it, expect, beforeAll, vi } from "vitest";
import { loadApp, loginAs, request } from "../helpers/app.js";
import { UserMock, FileMock, DirectoryMock } from "../helpers/modelMocks.js";
import { query, spyQuery } from "../helpers/query.js";
import { oid } from "../helpers/fixtures.js";
import { deleteR2Files } from "../../services/cloudflareR2Service.js";
import { Types } from "mongoose";

let app;
beforeAll(async () => {
  app = await loadApp();
});

const VALID_ID = "507f1f77bcf86cd799439011";
const ROOT = new Types.ObjectId("507f1f77bcf86cd799439011"); // has letters, so UPPERCASE differs


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
    FileMock.find.mockReturnValue(spyQuery([{ _id: oid(), name: "a.txt" }]));
    DirectoryMock.find.mockReturnValue(spyQuery([{ _id: oid(), name: "Docs" }]));
    DirectoryMock.countDocuments.mockResolvedValue(1);
    FileMock.countDocuments.mockResolvedValue(1);

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

describe("GET /directories/:directoryId? (paginated)", () => {
  const items = (n, prefix) => Array.from({ length: n }, (_, i) => ({ _id: oid(), name: `${prefix}${i}` }));

  /** Sets up an owned directory with `dirs` matching folders and `files` matching files. */
  function setup({ dirs, files, dirRows = items(dirs, "d"), fileRows = items(files, "f") }) {
    const { cookie, user } = loginAs();
    DirectoryMock.findOne.mockReturnValue(query({ _id: user.rootDirId, name: "root", userId: user._id }));
    DirectoryMock.countDocuments.mockResolvedValue(dirs);
    FileMock.countDocuments.mockResolvedValue(files);
    const dirFind = spyQuery(dirRows);
    const fileFind = spyQuery(fileRows);
    DirectoryMock.find.mockReturnValue(dirFind);
    FileMock.find.mockReturnValue(fileFind);
    return { cookie, user, dirFind, fileFind };
  }

  it("counts both collections with the owner + parent (+ search) filter", async () => {
    const { cookie, user } = setup({ dirs: 0, files: 0 });
    await request(app).get("/directories?page=1&limit=24&search=a.c").set("Cookie", cookie).expect(200);
    const filter = {
      parentDirId: user.rootDirId,
      userId: user._id,
      name: { $regex: "a\\.c", $options: "i" },
    };
    expect(DirectoryMock.countDocuments).toHaveBeenCalledWith(filter);
    // files additionally skip unfinished uploads
    expect(FileMock.countDocuments).toHaveBeenCalledWith({ ...filter, isUploading: { $ne: true } });
  });

  it("leaves unfinished uploads out of the file list query", async () => {
    const { cookie, user, fileFind } = setup({ dirs: 0, files: 3 });
    await request(app).get("/directories?page=1&limit=24").set("Cookie", cookie).expect(200);
    expect(FileMock.find).toHaveBeenCalledWith({
      parentDirId: user.rootDirId,
      userId: user._id,
      isUploading: { $ne: true },
    });
    expect(DirectoryMock.find).not.toHaveBeenCalled();
    expect(fileFind.limit).toHaveBeenCalledWith(3);
  });

  it("page 1 of 30 folders + 45 files is 24 folders and no files query", async () => {
    const { cookie, dirFind, fileFind } = setup({ dirs: 30, files: 45, dirRows: items(24, "d") });
    const res = await request(app).get("/directories?page=1&limit=24").set("Cookie", cookie).expect(200);
    expect(res.body.directories).toHaveLength(24);
    expect(res.body.files).toEqual([]);
    expect(dirFind.skip).toHaveBeenCalledWith(0);
    expect(dirFind.limit).toHaveBeenCalledWith(24);
    expect(FileMock.find).not.toHaveBeenCalled(); // limit(0) would mean "no limit" — must not be issued
    expect(fileFind.limit).not.toHaveBeenCalled();
    expect(res.body.pagination).toMatchObject({ currentPage: 1, totalPages: 4, totalItems: 75 });
  });

  it("page 2 straddles the folder/file boundary: last 6 folders then the first 18 files", async () => {
    const { cookie, dirFind, fileFind } = setup({ dirs: 30, files: 45, dirRows: items(6, "d"), fileRows: items(18, "f") });
    const res = await request(app).get("/directories?page=2&limit=24").set("Cookie", cookie).expect(200);
    expect(dirFind.skip).toHaveBeenCalledWith(24);
    expect(dirFind.limit).toHaveBeenCalledWith(6);
    expect(fileFind.skip).toHaveBeenCalledWith(0);
    expect(fileFind.limit).toHaveBeenCalledWith(18);
    expect(res.body.directories).toHaveLength(6);
    expect(res.body.files).toHaveLength(18);
  });

  it("page 3 is files only, offset by the folder count", async () => {
    const { cookie, fileFind } = setup({ dirs: 30, files: 45, dirRows: [], fileRows: items(24, "f") });
    const res = await request(app).get("/directories?page=3&limit=24").set("Cookie", cookie).expect(200);
    expect(DirectoryMock.find).not.toHaveBeenCalled();
    expect(fileFind.skip).toHaveBeenCalledWith(18);
    expect(fileFind.limit).toHaveBeenCalledWith(24);
    expect(res.body.pagination).toMatchObject({ currentPage: 3, hasNextPage: true, hasPrevPage: true });
  });

  it("keeps the response fields the frontend relies on (id alias, directory fields, spread of the directory)", async () => {
    const { cookie } = setup({ dirs: 1, files: 1 });
    const res = await request(app).get("/directories?page=1&limit=24").set("Cookie", cookie).expect(200);
    expect(res.body).toMatchObject({ name: "root" });
    expect(res.body.files[0]).toHaveProperty("id");
    expect(res.body.directories[0]).toHaveProperty("id");
  });

  it("an empty directory returns empty lists and one page without querying either collection", async () => {
    const { cookie } = setup({ dirs: 0, files: 0 });
    const res = await request(app).get("/directories?page=1&limit=24").set("Cookie", cookie).expect(200);
    expect(res.body.files).toEqual([]);
    expect(res.body.directories).toEqual([]);
    expect(res.body.pagination).toMatchObject({ totalItems: 0, totalPages: 1 });
    expect(DirectoryMock.find).not.toHaveBeenCalled();
    expect(FileMock.find).not.toHaveBeenCalled();
  });

  it("clamps a page past the end to the last page", async () => {
    const { cookie, fileFind } = setup({ dirs: 0, files: 26 });
    const res = await request(app).get("/directories?page=9&limit=24").set("Cookie", cookie).expect(200);
    expect(res.body.pagination).toMatchObject({ currentPage: 2, totalPages: 2 });
    expect(fileFind.skip).toHaveBeenCalledWith(24);
  });

  it("returns 404 (and reads no items) for a directory the user doesn't own", async () => {
    const { cookie } = setup({ dirs: 5, files: 5 });
    DirectoryMock.findOne.mockReturnValue(query(null));
    const res = await request(app).get(`/directories/${VALID_ID}?page=1&limit=24`).set("Cookie", cookie).expect(404);
    expect(res.body.error).toMatch(/not found or you do not have access/i);
    expect(DirectoryMock.find).not.toHaveBeenCalled();
    expect(FileMock.find).not.toHaveBeenCalled();
  });

  it("default order is newest first with a unique tiebreaker, and needs no collation", async () => {
    const { cookie, dirFind, fileFind } = setup({ dirs: 1, files: 1 });
    await request(app).get("/directories?page=1&limit=24").set("Cookie", cookie).expect(200);
    expect(dirFind.sort).toHaveBeenCalledWith({ createdAt: -1, _id: -1 });
    expect(fileFind.sort).toHaveBeenCalledWith({ createdAt: -1, _id: -1 });
    expect(dirFind.collation).not.toHaveBeenCalled();
  });

  it.each([
    ["name", "asc", { name: 1, _id: -1 }, { name: 1, _id: -1 }, true, true],
    ["name", "desc", { name: -1, _id: -1 }, { name: -1, _id: -1 }, true, true],
    ["date", "desc", { updatedAt: -1, _id: -1 }, { updatedAt: -1, _id: -1 }, false, false],
    ["size", "asc", { size: 1, _id: -1 }, { size: 1, _id: -1 }, false, false],
    // directories have no extension: "type" leaves them in the default order
    ["type", "asc", { createdAt: -1, _id: -1 }, { extension: 1, _id: -1 }, false, true],
  ])("sortBy=%s&sortDir=%s", async (sortBy, sortDir, dirSort, fileSort, dirCollated, fileCollated) => {
    const { cookie, dirFind, fileFind } = setup({ dirs: 1, files: 1 });
    await request(app).get(`/directories?page=1&limit=24&sortBy=${sortBy}&sortDir=${sortDir}`).set("Cookie", cookie).expect(200);
    expect(dirFind.sort).toHaveBeenCalledWith(dirSort);
    expect(fileFind.sort).toHaveBeenCalledWith(fileSort);
    expect(dirFind.collation.mock.calls.length > 0).toBe(dirCollated);
    expect(fileFind.collation.mock.calls.length > 0).toBe(fileCollated);
  });

  it.each(["password", "constructor", "__proto__", "createdAt"])("rejects sortBy=%s", async (sortBy) => {
    const { cookie } = setup({ dirs: 1, files: 1 });
    await request(app).get(`/directories?page=1&limit=24&sortBy=${sortBy}`).set("Cookie", cookie).expect(400);
    expect(FileMock.find).not.toHaveBeenCalled();
  });

  it.each(["up", "ASC", "toString", "1"])("rejects sortDir=%s", async (sortDir) => {
    const { cookie } = setup({ dirs: 1, files: 1 });
    await request(app).get(`/directories?page=1&limit=24&sortBy=name&sortDir=${sortDir}`).set("Cookie", cookie).expect(400);
  });

  it("treats empty sortBy/sortDir values as not set", async () => {
    const { cookie, dirFind } = setup({ dirs: 1, files: 1 });
    await request(app).get("/directories?page=1&limit=24&sortBy=&sortDir=").set("Cookie", cookie).expect(200);
    expect(dirFind.sort).toHaveBeenCalledWith({ createdAt: -1, _id: -1 });
  });

  it("never lets a client pick an arbitrary page size", async () => {
    const { cookie, fileFind } = setup({ dirs: 0, files: 500 });
    const res = await request(app).get("/directories?page=1&limit=100000").set("Cookie", cookie).expect(200);
    expect(res.body.pagination.limit).toBe(24);
    expect(fileFind.limit).toHaveBeenCalledWith(24);
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

    await request(app).post("/directories").set("Cookie", cookie).send({ dirname: "Photos" }).expect(201);

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

    await request(app).post(`/directories/${parent}/children`).set("Cookie", cookie).send({ dirname: "Deep" }).expect(201);

    expect(DirectoryMock.create).toHaveBeenCalledWith(
      expect.objectContaining({ path: [a, parent], userId: user._id }),
    );
  });

  it("names the folder 'New Folder' when no name is given", async () => {
    const { cookie, user } = loginAs();
    DirectoryMock.findOne.mockReturnValue(query({ _id: user.rootDirId, path: [] }));
    await request(app).post("/directories").set("Cookie", cookie).send({}).expect(201);
    expect(DirectoryMock.create).toHaveBeenCalledWith(expect.objectContaining({ name: "New Folder" }));
  });

  it("strips HTML from the folder name (stored-XSS protection)", async () => {
    const { cookie, user } = loginAs();
    DirectoryMock.findOne.mockReturnValue(query({ _id: user.rootDirId, path: [] }));
    await request(app)
      .post("/directories")
      .set("Cookie", cookie)
      .send({ dirname: "<img src=x onerror=alert(1)>Docs" })
      .expect(201);
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

  it.each([["lowercase", (id) => id], ["UPPERCASE", (id) => id.toUpperCase()]])(
    "refuses to rename the root folder (%s id in the URL)",
    async (_label, asText) => {
      const { cookie } = loginAs({ rootDirId: ROOT });
      const root = { _id: ROOT, name: "root", save: vi.fn() };
      DirectoryMock.findOne.mockResolvedValue(root);
      await request(app)
        .patch(`/directories/${asText(ROOT.toString())}`)
        .set("Cookie", cookie)
        .send({ newDirName: "Hacked" })
        .expect(403);
      expect(root.save).not.toHaveBeenCalled();
    },
  );

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
  it.each([["lowercase", (id) => id], ["UPPERCASE", (id) => id.toUpperCase()]])(
    "refuses to delete the user's root folder (%s id in the URL)",
    async (_label, asText) => {
      const { cookie } = loginAs({ rootDirId: ROOT });
      DirectoryMock.findOne.mockReturnValue(query({ _id: ROOT, size: 10, parentDirId: null }));
      await request(app).delete(`/directories/${asText(ROOT.toString())}`).set("Cookie", cookie).expect(403);
      expect(deleteR2Files).not.toHaveBeenCalled();
      expect(DirectoryMock.findOneAndDelete).not.toHaveBeenCalled();
      expect(DirectoryMock.deleteMany).not.toHaveBeenCalled();
    },
  );

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
    DirectoryMock.findOneAndDelete.mockResolvedValue(dir);
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
    expect(DirectoryMock.deleteMany).toHaveBeenCalledWith({ _id: { $in: [child] } });
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
    DirectoryMock.findOneAndDelete.mockResolvedValue(dir);
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

  it("does no accounting when another request already deleted the folder", async () => {
    const { cookie } = loginAs();
    const dir = { _id: oid(), size: 500, parentDirId: oid() };
    DirectoryMock.findOne.mockReturnValue(query(dir));
    DirectoryMock.findOneAndDelete.mockResolvedValue(null); // lost the race
    DirectoryMock.aggregate.mockResolvedValue([{ descendantIds: [] }]);
    FileMock.find.mockReturnValue(query([]));
    DirectoryMock.find.mockReturnValue(query([]));

    await request(app).delete(`/directories/${dir._id}`).set("Cookie", cookie).expect(404);

    expect(UserMock.updateOne).not.toHaveBeenCalled();
    expect(FileMock.deleteMany).not.toHaveBeenCalled();
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
