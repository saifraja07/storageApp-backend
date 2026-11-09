import Directory from "../models/directoryModel.js";
import User from "../models/userModel.js";

export async function updateDirectorySize(parentId, deltaSize, rootDirId) {
  const dir = await Directory.findById(parentId).select("path").lean();

  if (!dir) return;

  await Promise.all([
    Directory.updateMany(
      {
        _id: {
          $in: [rootDirId, ...dir.path, parentId],
        },
      },
      {
        $inc: { size: deltaSize },
      }
    ),
    User.updateOne(
      { rootDirId },
      {
        $inc: {
          usedStorageInBytes: deltaSize,
        },
      }
    ),
  ]);
}
