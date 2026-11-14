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

  for (const stale of staleFiles) {
    try {
      const claimed = await File.findOneAndDelete({
        _id: stale._id,
        isUploading: true,
        createdAt: { $lt: cutoff },
      });
      if (!claimed) continue;

      await User.updateOne(
        { _id: claimed.userId },
        { $inc: { reservedStorage: -claimed.size } }
      );

      await deleteR2File({
        key: `${claimed._id}${claimed.extension}`,
        userId: claimed.userId,
      }).catch((err) => {
        console.error("cleanupUploads: could not delete R2 object", `${claimed._id}${claimed.extension}`, err);
      });
    } catch (err) {
      console.error(err);
    }
  }
}
