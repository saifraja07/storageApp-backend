import { describe, it, expect, vi } from "vitest";
import { updateDirectorySize, releaseReservedStorage } from "../../../services/storageAccountingService.js";
import { UserMock, DirectoryMock } from "../../helpers/modelMocks.js";
import { query } from "../../helpers/query.js";
import { oid } from "../../helpers/fixtures.js";

vi.mock("../../../models/userModel.js", async () => ({
  default: (await import("../../helpers/modelMocks.js")).UserMock,
}));
vi.mock("../../../models/directoryModel.js", async () => ({
  default: (await import("../../helpers/modelMocks.js")).DirectoryMock,
}));

describe("updateDirectorySize", () => {
  it("adds the delta to the root, every ancestor and the parent, and to the user's usage", async () => {
    const [rootDirId, ancestor, parentId] = [oid(), oid(), oid()];
    DirectoryMock.findById.mockReturnValue(query({ path: [ancestor] }));

    await updateDirectorySize(parentId, 250, rootDirId);

    expect(DirectoryMock.findById).toHaveBeenCalledWith(parentId);
    expect(DirectoryMock.updateMany).toHaveBeenCalledWith(
      { _id: { $in: [rootDirId, ancestor, parentId] } },
      { $inc: { size: 250 } },
    );
    expect(UserMock.updateOne).toHaveBeenCalledWith(
      { rootDirId },
      { $inc: { usedStorageInBytes: 250 } },
    );
  });

  it("applies negative deltas when content is removed", async () => {
    const [rootDirId, parentId] = [oid(), oid()];
    DirectoryMock.findById.mockReturnValue(query({ path: [] }));

    await updateDirectorySize(parentId, -40, rootDirId);

    expect(DirectoryMock.updateMany).toHaveBeenCalledWith(
      { _id: { $in: [rootDirId, parentId] } },
      { $inc: { size: -40 } },
    );
    expect(UserMock.updateOne).toHaveBeenCalledWith(
      { rootDirId },
      { $inc: { usedStorageInBytes: -40 } },
    );
  });

  it("still updates the user's usage when the parent directory no longer exists", async () => {
    const rootDirId = oid();
    DirectoryMock.findById.mockReturnValue(query(null));

    await updateDirectorySize(null, -10, rootDirId);

    expect(DirectoryMock.updateMany).not.toHaveBeenCalled();
    expect(UserMock.updateOne).toHaveBeenCalledWith(
      { rootDirId },
      { $inc: { usedStorageInBytes: -10 } },
    );
  });
});

describe("releaseReservedStorage", () => {
  it("releases only the reservation of unfinished uploads", async () => {
    const userId = oid();
    const released = await releaseReservedStorage(userId, [
      { size: 100, isUploading: true },
      { size: 50, isUploading: true },
      { size: 999, isUploading: false },
    ]);
    expect(released).toBe(150);
    expect(UserMock.updateOne).toHaveBeenCalledWith({ _id: userId }, { $inc: { reservedStorage: -150 } });
  });

  it("does nothing when no file is an unfinished upload", async () => {
    await releaseReservedStorage(oid(), [{ size: 5, isUploading: false }]);
    expect(UserMock.updateOne).not.toHaveBeenCalled();
  });
});
