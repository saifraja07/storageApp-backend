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
});

describe("cleanupUploads", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => vi.useRealTimers());

  const cutoff = new Date(NOW.getTime() - 60 * 60 * 1000);

  it("only looks at unfinished uploads older than one hour", async () => {
    FileMock.find.mockResolvedValue([]);
    await cleanupUploads();
    expect(FileMock.find).toHaveBeenCalledWith({
      isUploading: true,
      createdAt: { $lt: cutoff },
    });
  });

  it("claims the record atomically, releases the reservation and removes the R2 object", async () => {
    const f = staleFile(250);
    FileMock.find.mockResolvedValue([f]);
    FileMock.findOneAndDelete.mockResolvedValue(f);
    deleteR2File.mockResolvedValue({});

    await cleanupUploads();

    expect(FileMock.findOneAndDelete).toHaveBeenCalledWith({
      _id: f._id,
      isUploading: true,
      createdAt: { $lt: cutoff },
    });
    expect(UserMock.updateOne).toHaveBeenCalledWith(
      { _id: f.userId },
      { $inc: { reservedStorage: -250 } },
    );
    expect(deleteR2File).toHaveBeenCalledWith({ key: `${f._id}.zip`, userId: f.userId });
  });

  it("does NOT release the reservation twice when another worker already claimed the file (M6)", async () => {
    const f = staleFile(250);
    FileMock.find.mockResolvedValue([f]);
    FileMock.findOneAndDelete.mockResolvedValue(null); // lost the race

    await cleanupUploads();

    expect(UserMock.updateOne).not.toHaveBeenCalled();
    expect(deleteR2File).not.toHaveBeenCalled();
  });

  it("keeps the quota correct and continues even if the R2 delete fails", async () => {
    const failing = staleFile();
    const ok = staleFile();
    FileMock.find.mockResolvedValue([failing, ok]);
    FileMock.findOneAndDelete.mockResolvedValueOnce(failing).mockResolvedValueOnce(ok);
    deleteR2File.mockRejectedValueOnce(new Error("R2 down")).mockResolvedValueOnce({});

    await cleanupUploads();

    expect(UserMock.updateOne).toHaveBeenCalledTimes(2);
    expect(deleteR2File).toHaveBeenCalledTimes(2);
  });

  it("does nothing when there are no stale uploads", async () => {
    FileMock.find.mockResolvedValue([]);
    await cleanupUploads();
    expect(FileMock.findOneAndDelete).not.toHaveBeenCalled();
    expect(deleteR2File).not.toHaveBeenCalled();
    expect(UserMock.updateOne).not.toHaveBeenCalled();
  });
});
