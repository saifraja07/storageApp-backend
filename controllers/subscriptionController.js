import crypto from "crypto";
import razorpay from "razorpay";
import Subscription from "../models/subscriptionModel.js";
import { isPremiumActive } from "../utils/isPremiumActive.js";
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
    const subscription = await Subscription.findOne({
      userId: req.user._id,
      status: {
        // "created" is deliberately absent: an unfinished checkout isn't a
        // subscription the user should see (or that can be "current").
        $in: ["authenticated", "active", "pending", "paused", "cancelled"],
      },
    })
      .sort({ createdAt: -1 })
      .lean();

    if (!subscription) {
      return res.json({ subscription: null, isPremiumActive: false });
    }

    return res.json({
      subscription,
      isPremiumActive: isPremiumActive(subscription),
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


    if (sub.status === "created") {
      // Cancel immidiately
      await rzp.subscriptions.cancel(subscriptionId, true);
    } else {
      // Cancel at the end of the current billing cycle.
      await rzp.subscriptions.cancel(subscriptionId, false);
    }

    // Immediately update local state so the UI reflects the change.
    // The webhook will later reconcile any additional fields.
    await Subscription.updateOne(
      { subscriptionId, userId: req.user._id },
      {
        status: "cancelled",
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
