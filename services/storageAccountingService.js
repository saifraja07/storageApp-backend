import Directory from "../models/directoryModel.js";
import User from "../models/userModel.js";

export async function updateDirectorySize(parentId, deltaSize, rootDirId) {
  const dir = await Directory.findById(parentId).select("path").lean();

  if (!dir) {
    // The parent folder is gone (legacy dangling data). The user's quota must
    // still be released/charged, otherwise it drifts away from reality.
    await User.updateOne(
      { rootDirId },
      { $inc: { usedStorageInBytes: deltaSize } }
    );
    return;
  }

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


/**
 * Unfinished uploads (isUploading) only ever held a *reservation*: they were
 * never added to directory sizes or usedStorageInBytes. When such files are
 * deleted, release the reservation instead of touching used storage.
 * Shared by single, folder and bulk delete so they cannot drift apart.
 */
export async function releaseReservedStorage(userId, files) {
  const reserved = files
    .filter(({ isUploading }) => isUploading)
    .reduce((sum, { size }) => sum + (size || 0), 0);
  if (reserved > 0) {
    await User.updateOne({ _id: userId }, { $inc: { reservedStorage: -reserved } });
  }
  return reserved;
}
