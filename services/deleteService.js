import File from "../models/fileModel.js";
import Directory from "../models/directoryModel.js";
import { deleteR2Files } from "./cloudflareR2Service.js";
import { updateDirectorySize, releaseReservedStorage } from "./storageAccountingService.js";
import { getDirectoryContent } from "../utils/directoryTree.js";

// Single, folder and bulk delete all go through here so their storage
// accounting can never drift apart.
//
//   completed file  → counted in directory sizes + usedStorageInBytes
//   unfinished file → only RESERVED (reservedStorage)

const DELETE_BATCH_SIZE = 50;

const r2Key = ({ _id, extension }) => ({
  Key: `${_id}${extension}`,
});

async function updateStorageAccounting(claimedFiles, user) {
  await releaseReservedStorage(user._id, claimedFiles);

  const directorySizeChanges = new Map();

  for (const file of claimedFiles) {
    if (file.isUploading) continue;

    const directoryId = String(file.parentDirId);

    const directoryChange = directorySizeChanges.get(directoryId) ?? {
      parentDirId: file.parentDirId,
      bytes: 0,
    };

    directoryChange.bytes += file.size || 0;
    directorySizeChanges.set(directoryId, directoryChange);
  }

  await Promise.all(
    [...directorySizeChanges.values()].map(
      ({ parentDirId, bytes }) =>
        updateDirectorySize(parentDirId, -bytes, user.rootDirId)
    )
  );
}

/**
 * Deletes the given files: R2 object first (if it fails, records and quota stay
 * untouched and the user can retry), then each record is claimed atomically.
 * Returns how many files were really removed.
 */
export async function deleteFiles(files, user) {
  if (files.length === 0) return 0;

  await deleteR2Files(files.map(r2Key), user._id);

  const claimedFiles = [];

  for (let i = 0; i < files.length; i += DELETE_BATCH_SIZE) {
    const claimedBatch = await Promise.all(
      files
        .slice(i, i + DELETE_BATCH_SIZE)
        .map((file) =>
          File.findOneAndDelete({
            _id: file._id,
            userId: user._id,
          })
        )
    );

    claimedFiles.push(...claimedBatch.filter(Boolean));
  }

  await updateStorageAccounting(claimedFiles, user);
  return claimedFiles.length;
}

/**
 * Deletes a folder, everything inside it, and fixes the accounting.
 * The caller must already have rejected the user's root folder.
 * Returns false when the folder was already gone (another request won).
 */
export async function deleteDirectoryTree(directoryData, user) {
  const { files, directories } = await getDirectoryContent(directoryData._id);

  if (files.length) {
    await deleteR2Files(files.map(r2Key), user._id);
  }

  // Claim the folder atomically: only the request that wins does the accounting.
  const claimed = await Directory.findOneAndDelete({
    _id: directoryData._id,
    userId: user._id,
  });
  if (!claimed) return false;

  // Re-read what is inside NOW: uploads may have finished (or started) since the
  // first listing, and `isUploading` decides how each file is accounted for.
  const dirIds = [directoryData._id, ...directories.map(({ _id }) => _id)];
  const current = await File.find({ parentDirId: { $in: dirIds } })
    .select("_id extension size isUploading")
    .lean();

  // Files that appeared after the first listing still have an R2 object.
  const known = new Set(files.map(({ _id }) => String(_id)));
  const late = current.filter(({ _id }) => !known.has(String(_id)));
  if (late.length) {
    await deleteR2Files(late.map(r2Key), user._id).catch((err) =>
      console.error("[delete] could not remove late R2 objects:", err)
    );
  }

  await File.deleteMany({ _id: { $in: current.map(({ _id }) => _id) } });
  await Directory.deleteMany({ _id: { $in: directories.map(({ _id }) => _id) } });

  // Unfinished uploads only hold a reservation; completed bytes are already in
  // the folder's size, which is what we subtract from the parents + user total.
  await releaseReservedStorage(user._id, current);
  await updateDirectorySize(claimed.parentDirId, -(claimed.size || 0), user.rootDirId);
  return true;
}
