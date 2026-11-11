import Razorpay from "razorpay";
import Subscription from "../models/subscriptionModel.js";

const rzp = new Razorpay({
  key_id: process.env.RAZORPAY_KEY_ID,
  key_secret: process.env.RAZORPAY_KEY_SECRET,
});

// Subscriptions that Razorpay could still bill (or retry) in the future.
const BILLABLE_STATUSES = ["created", "authenticated", "active", "pending", "paused"];
// Remote states that mean "nothing left to cancel".
const FINISHED_REMOTE = ["cancelled", "completed", "expired"];

/**
 * Stop every subscription of a user that is about to be permanently deleted.
 * Without this the customer keeps being charged for an account that no longer
 * exists. Cancels immediately on Razorpay (no cycle to honour — the account is
 * going away) and records the end locally.
 *
 * Throws if Razorpay refuses, so the caller can abort the deletion: deleting
 * the account and leaving the billing running would be the worst outcome.
 */
export async function cancelUserSubscriptions(userId) {
  const subs = await Subscription.find({ userId, status: { $in: BILLABLE_STATUSES } }).lean();
  if (!subs || subs.length === 0) return 0;

  for (const sub of subs) {
    try {
      await rzp.subscriptions.cancel(sub.subscriptionId);
    } catch (err) {
      // Already finished on Razorpay's side (cancelled from their dashboard…)? Fine.
      const remote = await rzp.subscriptions.fetch(sub.subscriptionId).catch(() => null);
      if (!FINISHED_REMOTE.includes(remote?.status)) {
        throw new Error(
          `Razorpay would not cancel ${sub.subscriptionId}: ${err?.error?.description ?? err?.message ?? err}`
        );
      }
    }
  }

  const now = new Date();
  await Subscription.updateMany(
    { _id: { $in: subs.map((s) => s._id) } },
    {
      status: "expired",
      cancelledAt: now,
      cancelAtPeriodEnd: false,
      endedAt: now,
      lastEventAt: now,
    }
  );
  return subs.length;
}
