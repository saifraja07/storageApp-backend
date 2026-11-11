import Subscription from "../models/subscriptionModel.js";
import User         from "../models/userModel.js";
import { downgradeStorage } from "../services/storageService.js";
import { FREE_PLAN }     from "../config/plans.js";

const EXPIRY_STATUSES = ["authenticated", "pending", "paused", "cancelled", "created"];

// Statuses that still entitle a user to paid storage while currentEnd is ahead.
const ENTITLING_STATUSES = ["active", "authenticated", "pending", "paused", "cancelled"];

export async function runSubscriptionExpiryJob() {
  const now = new Date();
  console.log(`[cron] subscription expiry job started at ${now.toLocaleString()}`);

  const expired = await Subscription.find({
    status:     { $in: EXPIRY_STATUSES },
    currentEnd: { $lt: now },
  }).lean();

  if (expired.length === 0) {
    console.log("[cron] no subscriptions to expire");
    return;
  }

  console.log(`[cron] found ${expired.length} subscription(s) to expire`);

  for (const sub of expired) {
    try {
      const user = await User.findById(sub.userId)
        .select("maxStorageInBytes")
        .lean();

      if (!user) {
        console.warn(`[cron] user ${sub.userId} not found — skipping`);
        continue;
      }

      // Mark expired FIRST to prevent duplicate processing by concurrent runs.
      // `endedAt` records when access really stopped; `cancelledAt` (if the user
      // cancelled) is left untouched, so history still says "cancelled".
      await Subscription.findByIdAndUpdate(sub._id, {
        status: "expired",
        endedAt: sub.currentEnd ?? now,
      });

      // The user may have already bought a NEW plan since this one lapsed (the
      // cron runs once a day). Never strip storage they have just paid for.
      const hasNewerPlan = await Subscription.exists({
        userId: sub.userId,
        _id: { $ne: sub._id },
        status: { $in: ENTITLING_STATUSES },
        currentEnd: { $gt: now },
      });

      if (hasNewerPlan) {
        console.log(
          `[cron] user ${sub.userId} already has a newer paid plan — expired only (sub ${sub.subscriptionId})`
        );
      } else if (user.maxStorageInBytes > FREE_PLAN.storage) {
        await downgradeStorage(sub.userId);
        console.log(
          `[cron] downgraded user ${sub.userId} ` +
          `(sub ${sub.subscriptionId}, was "${sub.status}", currentEnd ${sub.currentEnd})`
        );
      } else {
        console.log(
          `[cron] user ${sub.userId} already on free tier — expired only ` +
          `(sub ${sub.subscriptionId})`
        );
      }
    } catch (err) {
      console.error(`[cron] failed for sub ${sub.subscriptionId}:`, err);
    }
  }

  console.log("[cron] subscription expiry job complete");
}
