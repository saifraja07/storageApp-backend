import Payment from "../models/paymentModel.js";
import { PLAN_DETAILS } from "../config/plans.js";

// Revenue is computed from real captured payments (the Payment ledger), never
// from subscription status — so a cancelled or expired subscription's payments
// keep counting. Months are IST because that is the business's calendar.

export const IST_TZ = "Asia/Kolkata";
const IST_OFFSET_MS = 330 * 60 * 1000;

// Statuses whose money was actually received (refunds are subtracted below).
const COUNTED_STATUSES = ["captured", "partially_refunded", "refunded"];

const toRupees = (paise) => Math.round(paise) / 100;

/** "2026-11" for the IST month containing `date`. */
export function istMonthKey(date) {
  const d = new Date(date.getTime() + IST_OFFSET_MS);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

/** The last `count` IST month keys ending at `now`'s month, oldest first. */
export function lastMonthKeys(now, count) {
  const shifted = new Date(now.getTime() + IST_OFFSET_MS);
  let year = shifted.getUTCFullYear();
  let month = shifted.getUTCMonth(); // 0-based
  const keys = [];
  for (let i = 0; i < count; i += 1) {
    keys.unshift(`${year}-${String(month + 1).padStart(2, "0")}`);
    month -= 1;
    if (month < 0) {
      month = 11;
      year -= 1;
    }
  }
  return keys;
}

/**
 * Money actually received, in rupees:
 *   lifetime / thisMonth / lastMonth are NET of refunds; `byMonth` is the last
 *   `months` months (zero-filled) for a trend chart. Refunds are attributed to
 *   the month of the original payment.
 */
export async function getRevenueSummary(now = new Date(), months = 6) {
  const rows = await Payment.aggregate([
    { $match: { status: { $in: COUNTED_STATUSES } } },
    {
      $group: {
        _id: { $dateToString: { format: "%Y-%m", date: "$paidAt", timezone: IST_TZ } },
        grossPaise: { $sum: "$amountPaise" },
        refundedPaise: { $sum: "$refundedPaise" },
        payments: { $sum: 1 },
      },
    },
  ]);

  const byKey = new Map(rows.map((r) => [r._id, r]));
  const net = (r) => (r ? r.grossPaise - r.refundedPaise : 0);

  let grossPaise = 0;
  let refundedPaise = 0;
  let payments = 0;
  for (const r of rows) {
    grossPaise += r.grossPaise;
    refundedPaise += r.refundedPaise;
    payments += r.payments;
  }

  const keys = lastMonthKeys(now, months);
  const thisKey = keys[keys.length - 1];
  const lastKey = keys[keys.length - 2];

  // Calendar year (IST) of `now`, net of refunds.
  const yearPrefix = `${thisKey.slice(0, 4)}-`;
  let yearNet = 0;
  for (const r of rows) if (r._id.startsWith(yearPrefix)) yearNet += r.grossPaise - r.refundedPaise;

  return {
    thisYear: toRupees(yearNet),
    lifetime: toRupees(grossPaise - refundedPaise),
    grossLifetime: toRupees(grossPaise),
    refundedLifetime: toRupees(refundedPaise),
    totalPayments: payments,
    thisMonth: toRupees(net(byKey.get(thisKey))),
    lastMonth: toRupees(net(byKey.get(lastKey))),
    byMonth: keys.map((month) => ({
      month,
      revenue: toRupees(net(byKey.get(month))),
      payments: byKey.get(month)?.payments ?? 0,
    })),
  };
}

/**
 * Monthly recurring revenue: what the customers who WILL renew bring in per
 * month (yearly plans ÷ 12). Cancelled-but-still-active customers are excluded
 * because they will not pay again. Uses list prices, so it is an estimate.
 */
export function computeMrr(subscriptions) {
  let mrr = 0;
  for (const sub of subscriptions) {
    const plan = PLAN_DETAILS[sub.planId];
    if (!plan) continue;
    mrr += plan.cycle === "yearly" ? plan.price / 12 : plan.price;
  }
  return Math.round(mrr * 100) / 100;
}
