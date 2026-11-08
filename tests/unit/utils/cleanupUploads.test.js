import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { cleanupUploads } from "../../../utils/cleanupUploads.js";
import { FileMock, UserMock } from "../../helpers/modelMocks.js";
import { oid } from "../../helpers/fixtures.js";
import { deleteR2File } from "../../../services/cloudflareR2Service.js";

vi.mock("../../../models/fileModel.js", async () => ({
  default: (await import("../../helpers/modelMocks.js")).FileMock,
}));
vi.mock("../../../models/userModel.js", async () => ({
  default: (await import("../../helpers/modelMocks.js")).UserMock,
}));
vi.mock("../../../services/cloudflareR2Service.js", () => ({ deleteR2File: vi.fn() }));

const NOW = new Date("2026-03-01T10:00:00Z");

const staleFile = (size = 100) => ({
  _id: oid(),
  userId: oid(),
  extension: ".zip",
  size,
  deleteOne: vi.fn().mockResolvedValue({}),
});

describe("cleanupUploads", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => vi.useRealTimers());

  it("only looks at unfinished uploads older than one hour", async () => {
    FileMock.find.mockResolvedValue([]);
    await cleanupUploads();
    expect(FileMock.find).toHaveBeenCalledWith({
      isUploading: true,
      createdAt: { $lt: new Date(NOW.getTime() - 60 * 60 * 1000) },
    });
  });

  it("removes the R2 object, releases reserved storage and deletes the record", async () => {
    const f = staleFile(250);
    FileMock.find.mockResolvedValue([f]);
    deleteR2File.mockResolvedValue({});

    await cleanupUploads();

    expect(deleteR2File).toHaveBeenCalledWith({ key: `${f._id}.zip`, userId: f.userId });
    expect(UserMock.updateOne).toHaveBeenCalledWith(
      { _id: f.userId },
      { $inc: { reservedStorage: -250 } },
    );
    expect(f.deleteOne).toHaveBeenCalledTimes(1);
  });

  it("keeps the record (to retry next run) when the R2 delete fails, and continues", async () => {
    const failing = staleFile();
    const ok = staleFile();
    FileMock.find.mockResolvedValue([failing, ok]);
    deleteR2File.mockRejectedValueOnce(new Error("R2 down")).mockResolvedValueOnce({});

    await cleanupUploads();

    expect(failing.deleteOne).not.toHaveBeenCalled();
    expect(ok.deleteOne).toHaveBeenCalledTimes(1);
    expect(UserMock.updateOne).toHaveBeenCalledTimes(1);
  });

  it("does nothing when there are no stale uploads", async () => {
    FileMock.find.mockResolvedValue([]);
    await cleanupUploads();
    expect(deleteR2File).not.toHaveBeenCalled();
    expect(UserMock.updateOne).not.toHaveBeenCalled();
  });
});
