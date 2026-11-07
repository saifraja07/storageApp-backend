import File from "../models/fileModel.js";
import User from "../models/userModel.js";
import { deleteR2File } from "../services/cloudflareR2Service.js";

export async function cleanupUploads() {
  const cutoff = new Date(
    Date.now() - 60 * 60 * 1000
  ); // 1 hour

  const staleFiles = await File.find({
    isUploading: true,
    createdAt: {
      $lt: cutoff,
    },
  });

  for (const file of staleFiles) {
    try {
      // Remove the R2 object first, from the account that owns the file. If
      // that fails, the record is kept and retried on the next run instead of
      // being deleted while its object lingers in the bucket.
      await deleteR2File({
        key: `${file._id}${file.extension}`,
        userId: file.userId,
      });

      await Promise.all([
        User.updateOne(
          { _id: file.userId },
          {
            $inc: {
              reservedStorage: -file.size,
            },
          }
        ),
        file.deleteOne(),
      ]);

    } catch (err) {
      console.error(err);
    }
  }
}