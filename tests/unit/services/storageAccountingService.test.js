import { describe, it, expect, vi } from "vitest";
import { updateDirectorySize } from "../../../services/storageAccountingService.js";
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

  it("does nothing when the parent directory no longer exists", async () => {
    DirectoryMock.findById.mockReturnValue(query(null));

    await updateDirectorySize(oid(), 10, oid());

    expect(DirectoryMock.updateMany).not.toHaveBeenCalled();
    expect(UserMock.updateOne).not.toHaveBeenCalled();
  });
});
