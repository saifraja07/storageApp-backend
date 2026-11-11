import Razorpay from "razorpay";
import Subscription from "../models/subscriptionModel.js";
import WebhookEvent from "../models/webhookEventModel.js";
import Payment from "../models/paymentModel.js";
import { PLAN_IDS } from "../validators/subscriptionSchema.js";
import { PLAN_CONFIG, PLAN_DETAILS } from "../config/plans.js";
import { upgradeStorage, downgradeStorage } from "../services/storageService.js";

// Startup sanity-check — crash early if plans.js is out of sync with validator
for (const id of PLAN_IDS) {
  if (!(id in PLAN_CONFIG)) {
    throw new Error(
      `webhookController: no PLAN_CONFIG entry for plan "${id}" — update config/plans.js`
    );
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Convert Razorpay Unix timestamp (seconds) → JS Date, or null. */
function rzpDate(unix) {
  if (!unix) return null;
  return new Date(unix * 1000);
}

/**
 * Extract all subscription metadata from a Razorpay entity object.
 * Only includes keys that are actually present so we never overwrite
 * existing DB values with undefined.
 */
function extractSubMeta(entity) {
  const meta = {};
  if (entity.plan_id != null) meta.planId = entity.plan_id;
  if (entity.payment_method != null) meta.paymentMethod = entity.payment_method;
  if (entity.paid_count != null) meta.paidCount = entity.paid_count;
  if (entity.remaining_count != null) meta.remainingCount = entity.remaining_count;

  // Always write Date fields so currentEnd stays current
  meta.currentStart = rzpDate(entity.current_start);
  meta.currentEnd = rzpDate(entity.current_end);
  meta.startAt = rzpDate(entity.start_at);
  meta.endAt = rzpDate(entity.end_at);

  if (entity.ended_at) meta.endedAt = rzpDate(entity.ended_at);

  return meta;
}

/**
 * Find-and-update our local subscription record; returns the updated lean doc.
 *
 * Razorpay does not guarantee delivery order, so an event older than the newest
 * one already applied is STALE: it must not roll the state back (a late
 * "activated" re-opening a cancelled plan, say). For a stale event this returns
 * the current document with `stale: true` and writes nothing; unknown
 * subscriptions still return null.
 */
async function updateSub(subscriptionId, fields, eventAt = null, extraFilter = {}) {
  const guard = eventAt
    ? { $or: [{ lastEventAt: null }, { lastEventAt: { $lte: eventAt } }] }
    : {};
  const updated = await Subscription.findOneAndUpdate(
    { subscriptionId, ...guard, ...extraFilter },
    eventAt ? { ...fields, lastEventAt: eventAt } : fields,
    { returnDocument: "after" }
  ).lean();
  if (updated || !eventAt) return updated;

  if (await Subscription.exists({ subscriptionId })) {
    const current = await Subscription.findOne({ subscriptionId }).lean();
    return { ...current, stale: true };
  }
  return null;
}

/**
 * Record a collected payment in the ledger (idempotent on the Razorpay payment
 * id, so replayed / overlapping events — `activated` and `charged` can carry the
 * same payment — never double-count). Revenue reads from here.
 *
 * Throws on a database error so the webhook fails and Razorpay retries; returns
 * false when the event simply carries no payment to record.
 */
async function recordPayment({ paymentEntity, invoiceEntity, sub, subscriptionId }) {
  if (!paymentEntity?.id || typeof paymentEntity.amount !== "number") {
    console.error(
      `[webhook] ${subscriptionId}: no payment entity in the event — revenue NOT recorded; run the payments backfill`
    );
    return false;
  }
  // Only money that was actually collected counts as revenue.
  if (paymentEntity.status && paymentEntity.status !== "captured") return false;

  const details = PLAN_DETAILS[sub.planId] ?? {};
  const invoiceId = invoiceEntity?.id ?? paymentEntity.invoice_id ?? null;

  const set = {
    ...(paymentEntity.method && { method: paymentEntity.method }),
    ...(paymentEntity.fee != null && { feePaise: paymentEntity.fee }),
    ...(paymentEntity.tax != null && { taxPaise: paymentEntity.tax }),
    ...(invoiceId && { invoiceId }),
  };

  await Payment.findOneAndUpdate(
    { paymentId: paymentEntity.id },
    {
      ...(Object.keys(set).length > 0 && { $set: set }),
      // Immutable facts + refund totals are only written on first sight, so a
      // replayed event can never reset a refund that was applied since.
      $setOnInsert: {
        subscriptionId,
        userId: sub.userId,
        planId: sub.planId,
        planName: details.name ?? null,
        cycle: details.cycle ?? null,
        amountPaise: paymentEntity.amount,
        currency: paymentEntity.currency ?? "INR",
        status: "captured",
        refundedPaise: paymentEntity.amount_refunded ?? 0,
        refunds: [],
        source: "webhook",
        paidAt: rzpDate(paymentEntity.created_at) ?? new Date(),
      },
    },
    { upsert: true }
  );
  return true;
}

/**
 * refund.processed → subtract the refund from that payment's revenue.
 * Applied atomically and only once per refund id.
 */
async function handleRefund(logDoc, event, refund) {
  if (event !== "refund.processed") {
    await markLog(logDoc, "skipped");
    return;
  }
  if (typeof refund.amount !== "number" || !refund.payment_id) {
    await markLog(logDoc, "failed", `${event}: refund ${refund.id} has no payment id / amount`);
    return;
  }

  const updated = await Payment.findOneAndUpdate(
    { paymentId: refund.payment_id, "refunds.refundId": { $ne: refund.id } },
    [
      {
        $set: {
          refunds: {
            $concatArrays: [
              { $ifNull: ["$refunds", []] },
              [{ refundId: refund.id, amountPaise: refund.amount, createdAt: rzpDate(refund.created_at) }],
            ],
          },
          refundedPaise: { $add: [{ $ifNull: ["$refundedPaise", 0] }, refund.amount] },
        },
      },
      {
        $set: {
          status: {
            $cond: [{ $gte: ["$refundedPaise", "$amountPaise"] }, "refunded", "partially_refunded"],
          },
        },
      },
    ],
    // Mongoose refuses an aggregation-pipeline update unless told it is intended.
    { returnDocument: "after", updatePipeline: true }
  );

  if (updated) {
    console.log(`[webhook] refund ${refund.id} applied to payment ${refund.payment_id}`);
    await markLog(logDoc, "processed");
    return;
  }

  // Nothing matched: either this refund was already applied, or we never
  // recorded the payment (→ needs the backfill before the refund can land).
  if (await Payment.exists({ paymentId: refund.payment_id })) {
    await markLog(logDoc, "skipped");
    return;
  }
  const message = `${event} for payment ${refund.payment_id}: payment not in ledger — run the payments backfill`;
  console.error(`[webhook] ${message}`);
  await markLog(logDoc, "failed", message);
}

/** Persist or update the WebhookEvent log entry. */
// A PAID event (activated / charged) for a subscription we have no record of means
// a customer was charged but can't be given storage automatically. Never let that
// pass as "processed" — make it loud so it can be reconciled by hand.
async function flagUnmatchedPayment(logDoc, event, subscriptionId) {
  const message = `${event} for ${subscriptionId}: no matching local subscription — payment needs manual reconciliation`;
  console.error(`[webhook] ${message}`);
  await markLog(logDoc, "failed", message);
}

async function markLog(logDoc, status, error = null) {
  if (!logDoc) return;
  try {
    await WebhookEvent.findByIdAndUpdate(logDoc._id, {
      status,
      error: error ? String(error) : null,
    });
  } catch (err) {
    console.error("[webhook] failed to update WebhookEvent log:", err);
  }
}

// ── Subscription events ───────────────────────────────────────────────────────

async function handleSubscriptionEvent({ logDoc, event, entity, payload, eventAt }) {
  const subscriptionId = entity.id;
  const paymentEntity = payload?.payment?.entity;
  const invoiceEntity = payload?.invoice?.entity;

  switch (event) {
    // subscription.authenticated
    // → No premium access.
    case "subscription.authenticated": {
      console.log(`[webhook] ${subscriptionId} authenticated (ignored)`);
      await markLog(logDoc, "skipped");
      break;
    }

    // subscription.activated
    // First payment collected → upgrade storage immediately and record the payment.
    case "subscription.activated": {
      const meta = extractSubMeta(entity);
      const sub = await updateSub(subscriptionId, { ...meta, status: "active" }, eventAt);
      if (!sub) {
        await flagUnmatchedPayment(logDoc, "subscription.activated", subscriptionId);
        break;
      }
      // A stale event never changes entitlements, but the money was still received.
      if (!sub.stale) await upgradeStorage(sub.userId, sub.planId);
      // Ledger last: premium must never wait on bookkeeping. If this throws the
      // event is marked failed and retried, and every step above is idempotent.
      await recordPayment({ paymentEntity, invoiceEntity, sub, subscriptionId });
      console.log(`[webhook] ${subscriptionId} activated → plan ${sub.planId}${sub.stale ? " (stale: state kept)" : ""}`);
      await markLog(logDoc, "processed");
      break;
    }

    // subscription.charged
    // Recurring billing succeeded → stay active, record the payment.
    case "subscription.charged": {
      const meta = extractSubMeta(entity);
      const sub = await updateSub(subscriptionId, {
        ...meta,
        status: "active",
        lastChargedAt: new Date(),
        ...(paymentEntity?.id && { lastPaymentId: paymentEntity.id }),
        ...(invoiceEntity?.id && { invoiceId: invoiceEntity.id }),
        ...(paymentEntity?.method && { paymentMethod: paymentEntity.method }),
      }, eventAt);
      if (!sub) {
        await flagUnmatchedPayment(logDoc, "subscription.charged", subscriptionId);
        break;
      }
      if (!sub.stale) await upgradeStorage(sub.userId, sub.planId);
      await recordPayment({ paymentEntity, invoiceEntity, sub, subscriptionId });
      console.log(`[webhook] ${subscriptionId} charged → plan ${sub.planId}${sub.stale ? " (stale: state kept)" : ""}`);
      await markLog(logDoc, "processed");
      break;
    }

    // subscription.pending
    // Payment failed; Razorpay will auto-retry.
    // DO NOT downgrade — user already paid for this cycle's currentEnd.
    case "subscription.pending": {
      await updateSub(subscriptionId, {
        ...extractSubMeta(entity),
        status: "pending",
      }, eventAt);
      console.warn(`[webhook] ${subscriptionId} pending — Razorpay retrying`);
      await markLog(logDoc, "processed");
      break;
    }

    // subscription.paused
    // AutoPay / mandate disabled. Retain premium until currentEnd.
    case "subscription.paused": {
      const meta = extractSubMeta(entity);
      await updateSub(subscriptionId, {
        ...meta,
        status: "paused",
      }, eventAt);
      console.log(
        `[webhook] ${subscriptionId} paused — premium retained until ${meta.currentEnd}`
      );
      await markLog(logDoc, "processed");
      break;
    }

    // subscription.resumed
    // Resumed before currentEnd → restore active, upgrade storage.
    case "subscription.resumed": {
      const sub = await updateSub(subscriptionId, {
        ...extractSubMeta(entity),
        status: "active",
        cancelAtPeriodEnd: false,
      }, eventAt);
      if (sub && !sub.stale) {
        await upgradeStorage(sub.userId, sub.planId);
        console.log(`[webhook] ${subscriptionId} resumed → plan ${sub.planId}`);
      }
      await markLog(logDoc, "processed");
      break;
    }

    // subscription.cancelled
    // Cancelled by user or merchant. Retain premium until currentEnd.
    // The daily cron job will downgrade once currentEnd passes.
    case "subscription.cancelled": {
      const meta = extractSubMeta(entity);
      const cancelledSub = await updateSub(subscriptionId, {
        ...meta,
        status: "cancelled",
        cancelAtPeriodEnd: true,
      }, eventAt);
      // Remember WHEN it was cancelled, without overwriting the moment the user
      // actually clicked cancel (the cancel endpoint stamps it first).
      if (!cancelledSub?.stale) {
        await Subscription.updateOne(
          { subscriptionId, cancelledAt: null },
          { cancelledAt: new Date() }
        );
      }
      console.log(
        `[webhook] ${subscriptionId} cancelled — premium retained until ${meta.currentEnd}`
      );
      await markLog(logDoc, "processed");
      break;
    }

    // subscription.halted
    // All payment retries exhausted → downgrade immediately.
    case "subscription.halted": {
      const meta = extractSubMeta(entity);
      const sub = await updateSub(subscriptionId, {
        ...meta,
        status: "halted",
        haltedAt: new Date(),
      }, eventAt);
      if (sub && !sub.stale) {
        await downgradeStorage(sub.userId);
        console.warn(
          `[webhook] ${subscriptionId} halted — user ${sub.userId} downgraded immediately`
        );
      }
      await markLog(logDoc, "processed");
      break;
    }

    // subscription.completed
    // All billing cycles finished → downgrade immediately.
    case "subscription.completed": {
      const meta = extractSubMeta(entity);
      const sub = await updateSub(subscriptionId, {
        ...meta,
        status: "expired",
        endedAt: rzpDate(entity.ended_at) ?? new Date(),
      }, eventAt);
      if (sub && !sub.stale) {
        await downgradeStorage(sub.userId);
        console.log(
          `[webhook] ${subscriptionId} completed — user ${sub.userId} downgraded`
        );
      }
      await markLog(logDoc, "processed");
      break;
    }

    // subscription.updated
    // Metadata / plan changed mid-cycle.
    // Only re-run upgradeStorage if planId actually changed.
    case "subscription.updated": {
      const meta = extractSubMeta(entity);
      const oldSub = await Subscription.findOne({ subscriptionId }).lean();
      const sub = await updateSub(subscriptionId, meta, eventAt);

      if (sub && !sub.stale && oldSub && oldSub.planId !== sub.planId) {
        await upgradeStorage(sub.userId, sub.planId);
        console.log(
          `[webhook] ${subscriptionId} plan changed ${oldSub.planId} → ${sub.planId}`
        );
      } else {
        console.log(`[webhook] ${subscriptionId} metadata updated (no plan change)`);
      }
      await markLog(logDoc, "processed");
      break;
    }

    // Unknown / unhandled event
    default: {
      console.log(`[webhook] unhandled event "${event}" — skipped`);
      await markLog(logDoc, "skipped");
      break;
    }
  }
}

// ── Webhook handler ───────────────────────────────────────────────────────────

export const razorpayWebhook = async (req, res) => {
  // ── 1. Validate signature ─────────────────────────────────────────────────
  const signature = req.headers["x-razorpay-signature"];
  if (!signature) return res.sendStatus(400);

  let isValid = false;
  try {
    isValid = Razorpay.validateWebhookSignature(
      req.rawBody.toString("utf8"),
      signature,
      process.env.RAZORPAY_WEBHOOK_SECRET
    );
  } catch {
    return res.sendStatus(400);
  }
  if (!isValid) return res.sendStatus(400);

  // ── 2. Parse payload ───────────────────────────────────────────────────────
  const event = req.body?.event;
  const razorpayCreatedAt = rzpDate(req.body?.created_at);
  const payload = req.body?.payload;
  const entity = payload?.subscription?.entity;
  const refundEntity = payload?.refund?.entity;
  const isRefundEvent = !!event?.startsWith("refund.") && !!refundEntity?.id;

  if (!event || (!entity && !isRefundEvent)) {
    // Nothing we act on (e.g. payment.captured) — acknowledge so Razorpay stops retrying.
    console.warn("[webhook] missing event or subscription entity");
    return res.end("OK");
  }

  const subjectId = entity?.id ?? refundEntity?.payment_id;
  const webhookKey = isRefundEvent
    ? `${event}:${refundEntity.id}:${req.body.created_at}`
    : `${event}:${subjectId}:${req.body.created_at}`;

  // ── 3. Log event FIRST ─────────────────────────────────────────────────────
  // Unique index on webhookKey provides idempotency. A duplicate delivery is
  // ignored — unless the earlier attempt FAILED, in which case Razorpay's retry
  // is exactly what we want, so we take it over and process it again.
  let logDoc = null;
  try {
    logDoc = await WebhookEvent.create({
      webhookKey,
      event,
      subscriptionId: subjectId,
      razorpayCreatedAt,
      payload: req.body,
      status: "received",
    });
  } catch (err) {
    if (err.code === 11000) {
      try {
        logDoc = await WebhookEvent.findOneAndUpdate(
          { webhookKey, status: "failed" },
          { status: "received", error: null },
          { returnDocument: "after" }
        );
      } catch (claimErr) {
        console.error("[webhook] could not re-claim failed event:", claimErr);
        return res.sendStatus(500);
      }
      if (!logDoc) {
        console.log(`[webhook] duplicate event ${webhookKey} (${event}) — ignored`);
        return res.end("OK"); // idempotent: already processed
      }
      console.log(`[webhook] retrying previously failed event ${webhookKey}`);
    } else {
      // Non-idempotency error — still attempt processing but without a log doc
      console.error("[webhook] WebhookEvent insert failed:", err);
    }
  }

  // ── 4. Process, THEN acknowledge ───────────────────────────────────────────
  // Answering 200 only after the work succeeded means a transient failure
  // (database blip, deploy restart) returns 500 and Razorpay re-delivers the
  // event for up to 24h, instead of the payment being silently lost.
  try {
    if (isRefundEvent) {
      await handleRefund(logDoc, event, refundEntity);
    } else {
      await handleSubscriptionEvent({ logDoc, event, entity, payload, eventAt: razorpayCreatedAt });
    }
    return res.end("OK");
  } catch (err) {
    console.error(
      `[webhook] error processing [${event}] for ${subjectId}:`, err
    );
    await markLog(logDoc, "failed", err.message);
    return res.sendStatus(500);
  }
};
