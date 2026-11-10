import Razorpay from "razorpay";
import Subscription from "../models/subscriptionModel.js";
import WebhookEvent from "../models/webhookEventModel.js";
import { PLAN_IDS } from "../validators/subscriptionSchema.js";
import { PLAN_CONFIG } from "../config/plans.js";
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

/** Find-and-update our local subscription record; returns updated lean doc. */
async function updateSub(subscriptionId, fields, extraFilter = {}) {
  return Subscription.findOneAndUpdate(
    {
      subscriptionId,
      ...extraFilter,
    },
    fields,
    { returnDocument: "after" }
  ).lean();
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

  // ── 2. Acknowledge immediately ─────────────────────────────────────────────
  res.end("OK");

  // ── 3. Parse payload ───────────────────────────────────────────────────────
  const event = req.body?.event;
  const razorpayCreatedAt = rzpDate(req.body?.created_at);
  const entity = req.body?.payload?.subscription?.entity;

  if (!event || !entity) {
    console.warn("[webhook] missing event or subscription entity");
    return;
  }
  const subscriptionId = entity.id;

  const webhookKey = `${event}:${subscriptionId}:${req.body.created_at}`;

  // ── 4. Log event FIRST ─────────────────────────────────────────────────────
  // Unique index on webhookKey provides idempotency:
  // a duplicate delivery triggers a DuplicateKey error → we bail out safely.
  let logDoc = null;
  try {
    logDoc = await WebhookEvent.create({
      webhookKey,
      event,
      subscriptionId,
      razorpayCreatedAt,
      payload: req.body,
      status: "received",
    });
  } catch (err) {
    if (err.code === 11000) {
      console.log(`[webhook] duplicate event ${webhookKey} (${event}) — ignored`);
      return; // idempotent: already processed
    }
    // Non-idempotency error — still attempt processing but without a log doc
    console.error("[webhook] WebhookEvent insert failed:", err);
  }

  // ── 5. Dispatch ───────────────────────────────────────────────────────────
  const paymentEntity = req.body?.payload?.payment?.entity;
  const invoiceEntity = req.body?.payload?.invoice?.entity;

  try {
    switch (event) {
      // subscription.authenticated
      // → No premium access.
      case "subscription.authenticated": {
        console.log(`[webhook] ${subscriptionId} authenticated (ignored)`);
        await markLog(logDoc, "skipped");
        break;
      }

      // subscription.activated
      // First payment collected → upgrade storage immediately.
      case "subscription.activated": {
        const meta = extractSubMeta(entity);
        const sub = await updateSub(subscriptionId, { ...meta, status: "active" });
        if (!sub) {
          await flagUnmatchedPayment(logDoc, "subscription.activated", subscriptionId);
          break;
        }
        await upgradeStorage(sub.userId, sub.planId);
        console.log(`[webhook] ${subscriptionId} activated → plan ${sub.planId}`);
        await markLog(logDoc, "processed");
        break;
      }

      // subscription.charged
      // Recurring billing succeeded → stay active, record payment info.
      case "subscription.charged": {
        const meta = extractSubMeta(entity);
        const sub = await updateSub(subscriptionId, {
          ...meta,
          status: "active",
          lastChargedAt: new Date(),
          ...(paymentEntity?.id && { lastPaymentId: paymentEntity.id }),
          ...(invoiceEntity?.id && { invoiceId: invoiceEntity.id }),
          ...(paymentEntity?.method && { paymentMethod: paymentEntity.method }),
        });
        if (!sub) {
          await flagUnmatchedPayment(logDoc, "subscription.charged", subscriptionId);
          break;
        }
        await upgradeStorage(sub.userId, sub.planId);
        console.log(`[webhook] ${subscriptionId} charged → plan ${sub.planId}`);
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
        });
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
        });
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
        });
        if (sub) {
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
        await updateSub(subscriptionId, {
          ...meta,
          status: "cancelled",
        });
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
        });
        if (sub) {
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
        });
        if (sub) {
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
        const sub = await updateSub(subscriptionId, meta);

        if (sub && oldSub && oldSub.planId !== sub.planId) {
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
  } catch (err) {
    console.error(
      `[webhook] error processing [${event}] for ${subscriptionId}:`, err
    );
    await markLog(logDoc, "failed", err.message);
  }
};
