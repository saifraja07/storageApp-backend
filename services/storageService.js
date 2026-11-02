import User from "../models/userModel.js";
import File from "../models/fileModel.js";
import Directory from "../models/directoryModel.js";
import { deleteR2Files } from "./cloudflareR2Service.js";
import { PLAN_CONFIG, FREE_PLAN } from "../config/plans.js";

// ── Upgrade ───────────────────────────────────────────────────────────────────

export async function upgradeStorage(userId, planId) {
  const plan = PLAN_CONFIG[planId];
  if (!plan) {
    console.error(`upgradeStorage: unknown planId "${planId}" — skipping`);
    return;
  }
  await User.updateOne(
    {
      _id: userId,
    },
    {
      $set: {
        maxStorageInBytes: plan.storage,
        accessDevice: plan.deviceLimit
      },
    }
  );
}

// ── Downgrade ─────────────────────────────────────────────────────────────────

export async function downgradeStorage(userId) {
  const user = await User.findById(userId).select("rootDirId maxStorageInBytes usedStorageInBytes").lean();
  if (!user) {
    console.warn(`downgradeStorage: user ${userId} not found`);
    return;
  }

  // Already on the free tier — nothing to do
  if (user.maxStorageInBytes <= FREE_PLAN.storage) {
    console.log(`[storage] user ${userId} already on free tier, skipping downgrade`);
    return;
  }

  // Set quota first so new uploads are blocked immediately
  await User.updateOne(
    { _id: userId },
    {
      $set: {
        maxStorageInBytes: FREE_PLAN.storage,
        accessDevice: FREE_PLAN.deviceLimit,
      },
    }
  );
  console.log(`[storage] user ${userId} downgraded to free tier (${FREE_PLAN.storage} bytes)`);

  // How much storage does the user currently occupy?
  let usedBytes = user.usedStorageInBytes;
  if (usedBytes <= FREE_PLAN.storage) return; // already fits — no deletions needed

  // Fetch all completed files, oldest first
  const files = await File.find({ userId, isUploading: false })
    .sort({ createdAt: 1 })
    .select("_id extension size parentDirId")
    .lean();

  const toDelete = [];
  for (const file of files) {
    if (usedBytes <= FREE_PLAN.storage) break;
    toDelete.push(file);
    usedBytes -= file.size;
  }

  if (toDelete.length === 0) return;

  // 1. Remove from R2
  const r2Keys = toDelete.map((f) => ({ Key: `${f._id}${f.extension}` }));
  try {
    await deleteR2Files(r2Keys, userId);
  } catch (err) {
    // R2 deletion failure must not prevent the DB cleanup
    console.error(`[storage] R2 batch delete failed for user ${userId}:`, err);
  }

  // 2. Remove File documents
  const fileIds = toDelete.map((f) => f._id);
  await File.deleteMany({ _id: { $in: fileIds } });

  const sizeByDir = new Map();
  for (const f of toDelete) {
    const key = String(f.parentDirId);
    sizeByDir.set(key, (sizeByDir.get(key) ?? 0) + f.size);
  }

  // Total bytes being removed — used to decrement usedStorageInBytes once
  const totalDeletedBytes = toDelete.reduce((sum, f) => sum + f.size, 0);

  // Resolve all ancestor paths in parallel
  const dirUpdates = [...sizeByDir.entries()].map(async ([dirId, bytes]) => {
    const dir = await Directory.findById(dirId).select("path").lean();
    if (!dir) return;
    const affected = [user.rootDirId, ...dir.path, dir._id ?? dirId];
    await Directory.updateMany(
      { _id: { $in: affected } },
      { $inc: { size: -bytes } }
    );
  });
  await Promise.all([
    ...dirUpdates,
    User.updateOne(
      { _id: userId },
      { $inc: { usedStorageInBytes: -totalDeletedBytes } }
    ),
  ]);

  console.log(
    `[storage] deleted ${toDelete.length} file(s) for user ${userId} to fit free tier`
  );
}
