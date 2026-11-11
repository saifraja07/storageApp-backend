import { model, Schema } from "mongoose";

// One row per payment Razorpay actually collected — the single source of truth
// for revenue. Subscriptions change status (active → cancelled → expired), but
// a payment that was captured stays a payment: the money has already been
// received, so it must keep counting even after the subscription ends.
//
// Amounts are stored in paise (integers) to avoid floating-point drift, and are
// converted to rupees only at the API boundary.

export const PAYMENT_STATUSES = ["captured", "partially_refunded", "refunded"];

const refundSchema = new Schema(
  {
    refundId: { type: String, required: true },
    amountPaise: { type: Number, required: true, min: 0 },
    createdAt: { type: Date, default: null },
  },
  { _id: false }
);

const paymentSchema = new Schema(
  {
    // Razorpay payment id (pay_…). Unique → replayed webhooks can never double-count.
    paymentId: { type: String, required: true, unique: true },

    subscriptionId: { type: String, required: true, index: true },
    userId: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },

    // Snapshot of what was bought, so later catalogue / price changes never
    // rewrite history.
    planId: { type: String, required: true },
    planName: { type: String, default: null },
    cycle: { type: String, enum: ["monthly", "yearly", null], default: null },

    amountPaise: { type: Number, required: true, min: 0 },
    currency: { type: String, default: "INR" },

    status: { type: String, enum: PAYMENT_STATUSES, default: "captured" },
    refundedPaise: { type: Number, default: 0, min: 0 },
    refunds: { type: [refundSchema], default: [] },

    method: { type: String, default: null },
    // Razorpay's fee and the GST on it (paise) — lets you report net-of-fees later.
    feePaise: { type: Number, default: null },
    taxPaise: { type: Number, default: null },
    invoiceId: { type: String, default: null },

    // "webhook" = recorded live; "backfill" = imported from Razorpay afterwards.
    source: { type: String, enum: ["webhook", "backfill"], default: "webhook" },

    // When the customer paid (Razorpay's timestamp, not ours).
    paidAt: { type: Date, required: true, index: true },
  },
  { timestamps: true }
);

paymentSchema.index({ userId: 1, paidAt: -1 });

const Payment = model("Payment", paymentSchema);

export default Payment;
