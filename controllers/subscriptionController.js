import crypto from "crypto";
import razorpay from "razorpay";
import Subscription from "../models/subscriptionModel.js";
import Payment from "../models/paymentModel.js";
import { isPremiumActive } from "../utils/isPremiumActive.js";
import { getSubscriptionDisplay } from "../utils/subscriptionDisplay.js";
import { createSubscriptionSchema } from "../validators/subscriptionSchema.js";

const rzp = new razorpay({
  key_id: process.env.RAZORPAY_KEY_ID,
  key_secret: process.env.RAZORPAY_KEY_SECRET,
});

// Razorpay statuses that mean the customer has already authenticated / paid.
// A local "created" record in one of these states is NOT an abandoned
// checkout — our webhook just hasn't caught up yet.
const IN_FLIGHT_RZP_STATUSES = new Set(["authenticated", "active", "pending", "paused"]);

export const createSubscription = async (req, res, next) => {
  try {
    // 1. Validate — reject unknown / tampered plan IDs immediately
    const result = createSubscriptionSchema.safeParse(req.body);
    if (!result.success) {
      return res.status(400).json({ error: result.error.issues[0].message });
    }
    const { planId } = result.data;

    // 1. Already on a paid plan? A cancelled plan stays paid until its
    //    currentEnd, so it blocks a new checkout too (otherwise the expiry
    //    cron would later downgrade a user who has since re-subscribed).
    const activeSub = await Subscription.findOne({
      userId: req.user._id,
      status: { $in: ["active", "pending", "paused", "cancelled"] },
    })
      .sort({ currentEnd: -1 })
      .lean();

    if (activeSub && isPremiumActive(activeSub)) {
      return res.status(409).json({
        error:
          activeSub.status === "cancelled"
            ? "Your current plan is cancelled but stays active until it ends. You can choose a new plan after that."
            : "You already have an active subscription.",
      });
    }

    // 2. Checkout already started?
    const createdSub = await Subscription.findOne({
      userId: req.user._id,
      status: "created",
    })
      .sort({ createdAt: -1 })
      .lean();

    if (createdSub) {
      let rzpStatus = null;
      try {
        const rzpSubscription = await rzp.subscriptions.fetch(
          createdSub.subscriptionId
        );
        rzpStatus = rzpSubscription?.status ?? null;
      } catch {
        // Razorpay no longer knows this subscription — treat it as dead.
      }

      // Same plan and still unpaid → let the user resume that checkout.
      if (rzpStatus === "created" && createdSub.planId === planId) {
        return res.status(200).json({
          subscriptionId: createdSub.subscriptionId,
        });
      }

      // The customer already paid on Razorpay's side and our webhook hasn't
      // landed yet. Don't delete the record (we'd lose their payment) and
      // don't start a second subscription.
      if (IN_FLIGHT_RZP_STATUSES.has(rzpStatus)) {
        return res.status(409).json({
          error:
            "Your payment is still being processed. Please wait a minute and refresh the page.",
        });
      }

      // Abandoned checkout for a different plan (or dead on Razorpay's side):
      // cancel it there (immediately, best effort) and discard our record, so
      // the new checkout opens the plan the user actually picked.
      if (rzpStatus === "created") {
        try {
          await rzp.subscriptions.cancel(createdSub.subscriptionId);
        } catch (err) {
          console.warn(
            `[subscriptions] could not cancel abandoned checkout ${createdSub.subscriptionId}:`,
            err?.error?.description ?? err?.message ?? err
          );
        }
      }
      await Subscription.deleteOne({ _id: createdSub._id });
    }

    // 3. Create in Razorpay
    const rzpSub = await rzp.subscriptions.create({
      plan_id: planId,
      total_count: 12,
      quantity: 1,
      customer_notify: 1,
      notes: { userId: req.user._id.toString() },
    });

    // 4. Persist locally
    await Subscription.create({
      subscriptionId: rzpSub.id,
      planId,
      userId: req.user._id,
      status: rzpSub.status,
    });

    return res.status(201).json({ subscriptionId: rzpSub.id });
  } catch (err) {
    next(err);
  }
};

export const getActiveSubscription = async (req, res, next) => {
  try {
    let subscription = await Subscription.findOne({
      userId: req.user._id,
      status: {
        // "created" is deliberately absent: an unfinished checkout isn't a
        // subscription the user should see (or that can be "current").
        $in: ["authenticated", "active", "pending", "paused", "cancelled"],
      },
    })
      .sort({ createdAt: -1 })
      .lean();

    // A cancelled / paused / failing plan whose paid period is over is an ENDED
    // plan, even if the daily cron has not flipped its status yet.
    if (
      subscription &&
      ["cancelled", "paused", "pending"].includes(subscription.status) &&
      subscription.currentEnd &&
      !isPremiumActive(subscription)
    ) {
      subscription = null;
    }

    if (!subscription) {
      // Tell the client what ended last, so it can say "your Pro plan ended on…"
      // instead of silently showing the Free plan.
      const last = await Subscription.findOne({
        userId: req.user._id,
        paidCount: { $gt: 0 },
        $or: [
          { status: { $in: ["expired", "halted", "completed"] } },
          { status: { $in: ["cancelled", "paused", "pending"] }, currentEnd: { $lt: new Date() } },
        ],
      })
        .sort({ currentEnd: -1, createdAt: -1 })
        .lean();

      if (!last) return res.json({ subscription: null, isPremiumActive: false });

      const display = getSubscriptionDisplay({ ...last, status: last.status === "halted" ? "halted" : "expired" });
      return res.json({
        subscription: null,
        isPremiumActive: false,
        ended: {
          subscriptionId: last.subscriptionId,
          planId: last.planId,
          endedAt: last.endedAt ?? last.currentEnd ?? null,
          // "cancelled" (the user chose to leave) vs "expired" / "halted" (lapsed)
          reason: last.cancelledAt || last.status === "cancelled" ? "cancelled" : display.key,
        },
      });
    }

    return res.json({
      subscription,
      isPremiumActive: isPremiumActive(subscription),
      // What to SHOW (active / cancelling / past_due…), derived from the raw status.
      display: getSubscriptionDisplay(subscription),
    });
  } catch (err) {
    next(err);
  }
};

export const verifySubscription = async (req, res, next) => {
  try {
    const {
      razorpay_subscription_id,
      razorpay_payment_id,
      razorpay_signature,
    } = req.body;

    if (!razorpay_subscription_id || !razorpay_payment_id || !razorpay_signature) {
      return res.status(400).json({ error: "Missing verification fields." });
    }

    // Ownership check — ensure the subscription belongs to the authenticated user
    const sub = await Subscription.findOne({
      subscriptionId: razorpay_subscription_id,
      userId: req.user._id,
    }).lean();

    if (!sub) {
      return res.status(404).json({ error: "Subscription not found." });
    }

    // Razorpay signature verification
    // HMAC-SHA256 of "<payment_id>|<subscription_id>" using the key secret
    const body = `${razorpay_payment_id}|${razorpay_subscription_id}`;
    const expectedSignature = crypto
      .createHmac("sha256", process.env.RAZORPAY_KEY_SECRET)
      .update(body)
      .digest("hex");

    if (expectedSignature !== razorpay_signature) {
      return res.status(400).json({ error: "Invalid payment signature." });
    }

    // Signature valid — return verified: true.
    // Do NOT activate premium here; webhook handles that.
    return res.json({ verified: true });
  } catch (err) {
    next(err);
  }
};

export const cancelSubscription = async (req, res, next) => {
  try {
    const { subscriptionId } = req.params;

    if (!subscriptionId?.startsWith("sub_")) {
      return res.status(400).json({ error: "Invalid subscription ID." });
    }

    const sub = await Subscription.findOne({
      subscriptionId,
      userId: req.user._id,
    }).lean();

    if (!sub) {
      return res.status(404).json({ error: "Subscription not found." });
    }

    if (!["active", "authenticated", "created", "pending"].includes(sub.status)) {
      return res.status(409).json({
        error: `Cannot cancel a subscription with status "${sub.status}".`,
      });
    }


    // Razorpay's SDK takes `cancelAtCycleEnd` as the 2nd argument:
    //  • a paying (active) plan is cancelled at the END of the cycle the customer
    //    already paid for, so no further charge can ever happen;
    //  • anything not yet billing (unpaid checkout, authenticated, failed-payment
    //    retry, paused) has no paid cycle to wait for → cancel right away.
    const atCycleEnd = sub.status === "active";
    try {
      await rzp.subscriptions.cancel(subscriptionId, atCycleEnd);
    } catch (err) {
      // Already cancelled / completed on Razorpay's side (e.g. from their
      // dashboard)? Then our record is simply stale: sync it instead of failing.
      const remote = await rzp.subscriptions.fetch(subscriptionId).catch(() => null);
      if (!["cancelled", "completed", "expired"].includes(remote?.status)) throw err;
      console.warn(`[subscriptions] ${subscriptionId} was already ${remote.status} on Razorpay — syncing`);
    }

    // Immediately update local state so the UI reflects the change.
    // The webhook will later reconcile any additional fields.
    // `cancelAtPeriodEnd` + `cancelledAt` keep the history: the plan stays paid
    // (and shows as "cancelling") until currentEnd, and still reads "cancelled"
    // — not just "expired" — afterwards. `lastEventAt` makes any webhook that
    // was sent BEFORE this click (a delayed "activated", say) count as stale.
    await Subscription.updateOne(
      { subscriptionId, userId: req.user._id },
      {
        status: "cancelled",
        cancelledAt: new Date(),
        cancelAtPeriodEnd: sub.status !== "created",
        lastEventAt: new Date(),
      }
    );

    return res.json({
      message:
        sub.status === "created"
          ? "Subscription cancelled."
          : "Subscription cancelled. You will retain premium access until the end of your current billing cycle.",
    });
  } catch (err) {
    next(err);
  }
};

export const getUpdatePaymentLink = async (req, res, next) => {
  try {
    const { subscriptionId } = req.params;

    if (!subscriptionId?.startsWith("sub_")) {
      return res.status(400).json({ error: "Invalid subscription ID." });
    }

    const sub = await Subscription.findOne({
      subscriptionId,
      userId: req.user._id,
    }).lean();

    if (!sub) {
      return res.status(404).json({ error: "Subscription not found." });
    }

    if (!["active", "authenticated", "pending", "cancelled", "paused"].includes(sub.status)) {
      return res.status(409).json({
        error: "Payment method can only be updated on an active or pending subscription.",
      });
    }

    const rzpSub = await rzp.subscriptions.fetch(subscriptionId);

    return res.json({ updateUrl: rzpSub.short_url });
  } catch (err) {
    next(err);
  }
};

export const getPaymentHistory = async (req, res, next) => {
  try {
    const { subscriptionId } = req.params;

    if (!subscriptionId?.startsWith("sub_")) {
      return res.status(400).json({ error: "Invalid subscription ID." });
    }

    // Ownership check
    const sub = await Subscription.findOne({
      subscriptionId,
      userId: req.user._id,
    }).lean();

    if (!sub) {
      return res.status(404).json({ error: "Subscription not found." });
    }

    // Razorpay invoices.all returns items in descending order by default.
    const rzpInvoices = await rzp.invoices.all({ subscription_id: subscriptionId });

    const payments = (rzpInvoices.items ?? []).map((inv) => ({
      invoiceId: inv.id,
      amount: inv.amount / 100,     // paise → rupees
      paymentMethod: sub.paymentMethod,
      status: inv.status,
      createdAt: new Date(inv.created_at * 1000).toISOString(),
      invoiceUrl: inv.short_url ?? null,
    }));

    return res.json({ payments });
  } catch (err) {
    next(err);
  }
};

// The customer's full billing history — every payment they have ever made, across
// all their subscriptions, so it is still there after a plan has ended.
export const getMyPayments = async (req, res, next) => {
  try {
    const rows = await Payment.find({ userId: req.user._id })
      .sort({ paidAt: -1 })
      .limit(100)
      .lean();

    // Invoice download links live on Razorpay. Best effort: if Razorpay is slow
    // or down the history still loads, just without links.
    const invoiceUrls = new Map();
    const subscriptionIds = [...new Set(rows.map((r) => r.subscriptionId))].slice(0, 5);
    await Promise.all(
      subscriptionIds.map(async (id) => {
        try {
          const invoices = await rzp.invoices.all({ subscription_id: id });
          for (const inv of invoices.items ?? []) {
            if (inv.short_url) invoiceUrls.set(inv.id, inv.short_url);
          }
        } catch (err) {
          console.warn(`[subscriptions] invoice links unavailable for ${id}:`, err?.message ?? err);
        }
      })
    );

    const payments = rows.map((p) => ({
      paymentId: p.paymentId,
      invoiceId: p.invoiceId,
      amount: p.amountPaise / 100,
      refundedAmount: (p.refundedPaise ?? 0) / 100,
      status: p.status,
      paymentMethod: p.method,
      planName: p.planName,
      cycle: p.cycle,
      createdAt: p.paidAt,
      invoiceUrl: (p.invoiceId && invoiceUrls.get(p.invoiceId)) || null,
    }));

    return res.json({ payments });
  } catch (err) {
    next(err);
  }
};
