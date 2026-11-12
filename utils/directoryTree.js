import Directory from "../models/directoryModel.js";
import File from "../models/fileModel.js";


export async function getDirectoryContent(rootId) {
  const [result] = await Directory.aggregate([
    { $match: { _id: rootId } },
    {
      $graphLookup: {
        from: "directories",
        startWith: "$_id",
        connectFromField: "_id",
        connectToField: "parentDirId",
        as: "descendants",
      },
    },
    {
      $project: {
        _id: 0,
        descendantIds: "$descendants._id",
      },
    },
  ]);

  const descendantIds = result?.descendantIds ?? [];
  const dirIds = [rootId, ...descendantIds];

  const [files, directories] = await Promise.all([
    File.find({ parentDirId: { $in: dirIds } })
      .select("_id extension size isUploading")
      .lean(),
    Directory.find({ _id: { $in: descendantIds } })
      .select("_id")
      .lean(),
  ]);

  return { files, directories };
}
