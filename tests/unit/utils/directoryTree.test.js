import { describe, it, expect, vi } from "vitest";
import { getDirectoryContent } from "../../../utils/directoryTree.js";
import { FileMock, DirectoryMock } from "../../helpers/modelMocks.js";
import { query } from "../../helpers/query.js";
import { oid } from "../../helpers/fixtures.js";

vi.mock("../../../models/fileModel.js", async () => ({
  default: (await import("../../helpers/modelMocks.js")).FileMock,
}));
vi.mock("../../../models/directoryModel.js", async () => ({
  default: (await import("../../helpers/modelMocks.js")).DirectoryMock,
}));

describe("getDirectoryContent", () => {
  it("collects files from the root and every descendant directory", async () => {
    const root = oid();
    const [d1, d2] = [oid(), oid()];
    const files = [{ _id: oid(), extension: ".txt" }];
    const directories = [{ _id: d1 }, { _id: d2 }];

    DirectoryMock.aggregate.mockResolvedValue([{ descendantIds: [d1, d2] }]);
    FileMock.find.mockReturnValue(query(files));
    DirectoryMock.find.mockReturnValue(query(directories));

    const result = await getDirectoryContent(root);

    expect(result).toEqual({ files, directories });
    expect(FileMock.find).toHaveBeenCalledWith({ parentDirId: { $in: [root, d1, d2] } });
    expect(DirectoryMock.find).toHaveBeenCalledWith({ _id: { $in: [d1, d2] } });
  });

  it("walks the directory tree with $graphLookup starting from the root", async () => {
    const root = oid();
    DirectoryMock.aggregate.mockResolvedValue([{ descendantIds: [] }]);
    FileMock.find.mockReturnValue(query([]));
    DirectoryMock.find.mockReturnValue(query([]));

    await getDirectoryContent(root);

    const pipeline = DirectoryMock.aggregate.mock.calls[0][0];
    expect(pipeline[0]).toEqual({ $match: { _id: root } });
    expect(pipeline[1].$graphLookup).toMatchObject({
      from: "directories",
      connectFromField: "_id",
      connectToField: "parentDirId",
    });
  });

  it("handles an empty folder / missing aggregate result", async () => {
    const root = oid();
    DirectoryMock.aggregate.mockResolvedValue([]);
    FileMock.find.mockReturnValue(query([]));
    DirectoryMock.find.mockReturnValue(query([]));

    const result = await getDirectoryContent(root);

    expect(result).toEqual({ files: [], directories: [] });
    expect(FileMock.find).toHaveBeenCalledWith({ parentDirId: { $in: [root] } });
  });
});
