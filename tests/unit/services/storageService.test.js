import { describe, it, expect, vi, beforeEach } from "vitest";
import { upgradeStorage, downgradeStorage } from "../../../services/storageService.js";
import { UserMock, FileMock, DirectoryMock } from "../../helpers/modelMocks.js";
import { query } from "../../helpers/query.js";
import { oid } from "../../helpers/fixtures.js";
import { FREE_PLAN, PLAN_CONFIG } from "../../../config/plans.js";
import { deleteR2Files } from "../../../services/cloudflareR2Service.js";

vi.mock("../../../models/userModel.js", async () => ({
  default: (await import("../../helpers/modelMocks.js")).UserMock,
}));
vi.mock("../../../models/fileModel.js", async () => ({
  default: (await import("../../helpers/modelMocks.js")).FileMock,
}));
vi.mock("../../../models/directoryModel.js", async () => ({
  default: (await import("../../helpers/modelMocks.js")).DirectoryMock,
}));
vi.mock("../../../services/cloudflareR2Service.js", () => ({ deleteR2Files: vi.fn() }));

const MB = 1024 ** 2;

beforeEach(() => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("upgradeStorage", () => {
  it("applies the plan's storage and device limits to the user", async () => {
    const userId = oid();
    const [planId, plan] = Object.entries(PLAN_CONFIG)[0];
    await upgradeStorage(userId, planId);
    expect(UserMock.updateOne).toHaveBeenCalledWith(
      { _id: userId },
      { $set: { maxStorageInBytes: plan.storage, accessDevice: plan.deviceLimit } },
    );
  });

  it("does nothing for an unknown plan id", async () => {
    await upgradeStorage(oid(), "plan_unknown");
    expect(UserMock.updateOne).not.toHaveBeenCalled();
  });
});

describe("downgradeStorage", () => {
  const userId = oid();
  const rootDirId = oid();
  const dirId = oid();

  const paidUser = (usedStorageInBytes) => ({
    _id: userId,
    rootDirId,
    maxStorageInBytes: 100 * 1024 ** 3,
    usedStorageInBytes,
  });

  const file = (name, size) => ({
    _id: oid(),
    extension: ".bin",
    size,
    parentDirId: dirId,
    name,
  });

  it("does nothing when the user does not exist", async () => {
    UserMock.findById.mockReturnValue(query(null));
    await downgradeStorage(userId);
    expect(UserMock.updateOne).not.toHaveBeenCalled();
  });

  it("does nothing when the user is already on the free tier", async () => {
    UserMock.findById.mockReturnValue(
      query({ ...paidUser(0), maxStorageInBytes: FREE_PLAN.storage }),
    );
    await downgradeStorage(userId);
    expect(UserMock.updateOne).not.toHaveBeenCalled();
  });

  it("lowers the quota and keeps all files when usage already fits the free tier", async () => {
    UserMock.findById.mockReturnValue(query(paidUser(100 * MB)));
    await downgradeStorage(userId);
    expect(UserMock.updateOne).toHaveBeenCalledTimes(1);
    expect(UserMock.updateOne).toHaveBeenCalledWith(
      { _id: userId },
      { $set: { maxStorageInBytes: FREE_PLAN.storage, accessDevice: FREE_PLAN.deviceLimit } },
    );
    expect(FileMock.find).not.toHaveBeenCalled();
    expect(deleteR2Files).not.toHaveBeenCalled();
  });

  describe("when usage exceeds the free tier", () => {
    const f1 = file("oldest", 100 * MB);
    const f2 = file("older", 100 * MB);
    const f3 = file("newest", 100 * MB);

    beforeEach(() => {
      // 700 MB used, free tier is 512 MB → the two oldest files must go.
      UserMock.findById.mockReturnValue(query(paidUser(700 * MB)));
      FileMock.find.mockReturnValue(query([f1, f2, f3]));
      DirectoryMock.findById.mockReturnValue(query({ _id: dirId, path: [] }));
    });

    it("deletes the oldest files first, only as many as needed", async () => {
      await downgradeStorage(userId);

      expect(FileMock.find).toHaveBeenCalledWith({ userId, isUploading: false });
      expect(deleteR2Files).toHaveBeenCalledWith(
        [{ Key: `${f1._id}.bin` }, { Key: `${f2._id}.bin` }],
        userId,
      );
      expect(FileMock.deleteMany).toHaveBeenCalledWith({ _id: { $in: [f1._id, f2._id] } });
    });

    it("keeps directory sizes and the user's usage in sync", async () => {
      await downgradeStorage(userId);

      expect(DirectoryMock.updateMany).toHaveBeenCalledWith(
        { _id: { $in: [rootDirId, dirId] } },
        { $inc: { size: -200 * MB } },
      );
      expect(UserMock.updateOne).toHaveBeenCalledWith(
        { _id: userId },
        { $inc: { usedStorageInBytes: -200 * MB } },
      );
    });

    it("still cleans up the database when the R2 delete fails", async () => {
      deleteR2Files.mockRejectedValue(new Error("R2 down"));
      await downgradeStorage(userId);
      expect(FileMock.deleteMany).toHaveBeenCalledTimes(1);
      expect(console.error).toHaveBeenCalled();
    });
  });
});
