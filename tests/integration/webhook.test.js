import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import { loadApp, request } from "../helpers/app.js";
import { SubscriptionMock, WebhookEventMock, PaymentMock } from "../helpers/modelMocks.js";
import { query } from "../helpers/query.js";
import { hmacHex, oid } from "../helpers/fixtures.js";
import { upgradeStorage, downgradeStorage } from "../../services/storageService.js";

const SECRET = "rzp_webhook_secret"; // from tests/setup/env.js
const PLAN_ID = "plan_T7QOKw1SWn3YA9";
const CREATED_AT = 1_700_000_000;
const logDoc = { _id: "log-1" };
const userId = oid();

let app;
beforeAll(async () => {
  app = await loadApp();
});

beforeEach(() => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  WebhookEventMock.create.mockResolvedValue(logDoc);
  WebhookEventMock.findByIdAndUpdate.mockResolvedValue({});
  SubscriptionMock.findOneAndUpdate.mockReturnValue(query({ userId, planId: PLAN_ID }));
});

const entity = (overrides = {}) => ({
  id: "sub_1",
  plan_id: PLAN_ID,
  current_start: 1_700_000_000,
  current_end: 1_702_600_000,
  paid_count: 1,
  ...overrides,
});

const body = (event, entityOverrides = {}, extraPayload = {}) => ({
  event,
  created_at: CREATED_AT,
  payload: { subscription: { entity: entity(entityOverrides) }, ...extraPayload },
});

/** Sends a correctly signed webhook (pass `signature` to override). */
function send(payload, { signature, raw } = {}) {
  const rawBody = raw ?? JSON.stringify(payload);
  return request(app)
    .post("/webhooks/razorpay")
    .set("Content-Type", "application/json")
    .set("x-razorpay-signature", signature ?? hmacHex(SECRET, rawBody))
    .send(rawBody);
}

const logged = (status, error = null) =>
  expect(WebhookEventMock.findByIdAndUpdate).toHaveBeenCalledWith(logDoc._id, { status, error });

const settled = () => new Promise((resolve) => setTimeout(resolve, 25));

describe("POST /webhooks/razorpay — signature verification", () => {
  it("rejects requests without a signature header", async () => {
    await request(app)
      .post("/webhooks/razorpay")
      .set("Content-Type", "application/json")
      .send(JSON.stringify(body("subscription.activated")))
      .expect(400);
    expect(WebhookEventMock.create).not.toHaveBeenCalled();
  });

  it("rejects an invalid signature and does not touch the database", async () => {
    await send(body("subscription.activated"), { signature: "0".repeat(64) }).expect(400);
    await settled();
    expect(WebhookEventMock.create).not.toHaveBeenCalled();
    expect(SubscriptionMock.findOneAndUpdate).not.toHaveBeenCalled();
    expect(upgradeStorage).not.toHaveBeenCalled();
  });

  it("rejects a signature made with the wrong secret", async () => {
    const raw = JSON.stringify(body("subscription.activated"));
    await send(null, { raw, signature: hmacHex("attacker-secret", raw) }).expect(400);
    expect(upgradeStorage).not.toHaveBeenCalled();
  });

  it("rejects a valid signature replayed over a tampered body", async () => {
    const original = JSON.stringify(body("subscription.activated"));
    const tampered = JSON.stringify(body("subscription.activated", { plan_id: "plan_T7QV7r2nId24Vo" }));
    await send(null, { raw: tampered, signature: hmacHex(SECRET, original) }).expect(400);
    expect(upgradeStorage).not.toHaveBeenCalled();
  });

  it("does not accept a non-JSON body", async () => {
    // NOTE: webhookRoutes.js attaches `status: 400` to this error but the
    // global error handler reads `statusCode`, so today this surfaces as a 500.
    // Either way it must be an error and must never reach the database.
    const raw = "{ definitely not json";
    const res = await send(null, { raw });
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(WebhookEventMock.create).not.toHaveBeenCalled();
  });

  it("acknowledges a valid webhook with 200 OK", async () => {
    const res = await send(body("subscription.activated")).expect(200);
    expect(res.text).toBe("OK");
  });
});

describe("POST /webhooks/razorpay — event processing", () => {
  it("logs each event under a unique key before processing (idempotency)", async () => {
    await send(body("subscription.activated")).expect(200);
    await vi.waitFor(() => expect(WebhookEventMock.create).toHaveBeenCalled());
    expect(WebhookEventMock.create).toHaveBeenCalledWith(
      expect.objectContaining({
        webhookKey: `subscription.activated:sub_1:${CREATED_AT}`,
        event: "subscription.activated",
        subscriptionId: "sub_1",
        status: "received",
      }),
    );
  });

  it("ignores duplicate deliveries without processing them again", async () => {
    WebhookEventMock.create.mockRejectedValue(Object.assign(new Error("dup"), { code: 11000 }));
    await send(body("subscription.activated")).expect(200);
    await vi.waitFor(() => expect(WebhookEventMock.create).toHaveBeenCalled());
    await settled();
    expect(SubscriptionMock.findOneAndUpdate).not.toHaveBeenCalled();
    expect(upgradeStorage).not.toHaveBeenCalled();
  });

  it("does nothing when the payload has no subscription entity", async () => {
    await send({ event: "payment.captured", created_at: CREATED_AT, payload: {} }).expect(200);
    await settled();
    expect(WebhookEventMock.create).not.toHaveBeenCalled();
  });

  it.each(["subscription.activated", "subscription.charged"])(
    "%s for a subscription we have no record of is flagged as failed, not silently 'processed'",
    async (event) => {
      SubscriptionMock.findOneAndUpdate.mockReturnValue(query(null));
      await send(body(event)).expect(200);
      await vi.waitFor(() =>
        expect(WebhookEventMock.findByIdAndUpdate).toHaveBeenCalledWith(logDoc._id, {
          status: "failed",
          error: expect.stringContaining("manual reconciliation"),
        }),
      );
      expect(upgradeStorage).not.toHaveBeenCalled();
      expect(console.error).toHaveBeenCalledWith(expect.stringContaining("sub_1"));
    },
  );

  it("subscription.activated → marks active and upgrades the user's storage", async () => {
    await send(body("subscription.activated")).expect(200);
    await vi.waitFor(() => logged("processed"));

    const [filter, update] = SubscriptionMock.findOneAndUpdate.mock.calls[0];
    expect(filter.subscriptionId).toBe("sub_1");
    expect(update).toMatchObject({ status: "active", planId: PLAN_ID, paidCount: 1 });
    expect(update.currentEnd).toEqual(new Date(1_702_600_000 * 1000));
    expect(upgradeStorage).toHaveBeenCalledWith(userId, PLAN_ID);
  });

  it("subscription.charged → stays active, stores payment details and upgrades", async () => {
    const payload = body(
      "subscription.charged",
      {},
      {
        payment: { entity: { id: "pay_9", method: "upi" } },
        invoice: { entity: { id: "inv_9" } },
      },
    );
    await send(payload).expect(200);
    await vi.waitFor(() => logged("processed"));

    const update = SubscriptionMock.findOneAndUpdate.mock.calls[0][1];
    expect(update).toMatchObject({
      status: "active",
      lastPaymentId: "pay_9",
      invoiceId: "inv_9",
      paymentMethod: "upi",
    });
    expect(update.lastChargedAt).toBeInstanceOf(Date);
    expect(upgradeStorage).toHaveBeenCalledWith(userId, PLAN_ID);
  });

  it("subscription.resumed → active again with storage restored", async () => {
    await send(body("subscription.resumed")).expect(200);
    await vi.waitFor(() => logged("processed"));
    expect(SubscriptionMock.findOneAndUpdate.mock.calls[0][1]).toMatchObject({ status: "active" });
    expect(upgradeStorage).toHaveBeenCalledWith(userId, PLAN_ID);
  });

  it.each([
    ["subscription.pending", "pending"],
    ["subscription.paused", "paused"],
    ["subscription.cancelled", "cancelled"],
  ])("%s → records %s and keeps the paid-for storage (no downgrade)", async (event, status) => {
    await send(body(event)).expect(200);
    await vi.waitFor(() => logged("processed"));
    expect(SubscriptionMock.findOneAndUpdate.mock.calls[0][1]).toMatchObject({ status });
    expect(downgradeStorage).not.toHaveBeenCalled();
    expect(upgradeStorage).not.toHaveBeenCalled();
  });

  it("subscription.halted → downgrades immediately", async () => {
    await send(body("subscription.halted")).expect(200);
    await vi.waitFor(() => logged("processed"));
    const update = SubscriptionMock.findOneAndUpdate.mock.calls[0][1];
    expect(update).toMatchObject({ status: "halted" });
    expect(update.haltedAt).toBeInstanceOf(Date);
    expect(downgradeStorage).toHaveBeenCalledWith(userId);
  });

  it("subscription.completed → marks expired and downgrades", async () => {
    await send(body("subscription.completed", { ended_at: 1_705_000_000 })).expect(200);
    await vi.waitFor(() => logged("processed"));
    const update = SubscriptionMock.findOneAndUpdate.mock.calls[0][1];
    expect(update).toMatchObject({ status: "expired" });
    expect(update.endedAt).toEqual(new Date(1_705_000_000 * 1000));
    expect(downgradeStorage).toHaveBeenCalledWith(userId);
  });

  it("subscription.authenticated → skipped (no premium before the first payment)", async () => {
    await send(body("subscription.authenticated")).expect(200);
    await vi.waitFor(() => logged("skipped"));
    expect(SubscriptionMock.findOneAndUpdate).not.toHaveBeenCalled();
    expect(upgradeStorage).not.toHaveBeenCalled();
  });

  it("subscription.updated with a plan change → upgrades to the new plan", async () => {
    const NEW_PLAN = "plan_T7QV7r2nId24Vo";
    SubscriptionMock.findOne.mockReturnValue(query({ planId: PLAN_ID }));
    SubscriptionMock.findOneAndUpdate.mockReturnValue(query({ userId, planId: NEW_PLAN }));
    await send(body("subscription.updated", { plan_id: NEW_PLAN })).expect(200);
    await vi.waitFor(() => logged("processed"));
    expect(upgradeStorage).toHaveBeenCalledWith(userId, NEW_PLAN);
  });

  it("subscription.updated without a plan change → metadata only", async () => {
    SubscriptionMock.findOne.mockReturnValue(query({ planId: PLAN_ID }));
    await send(body("subscription.updated")).expect(200);
    await vi.waitFor(() => logged("processed"));
    expect(upgradeStorage).not.toHaveBeenCalled();
  });

  it("unknown events are acknowledged and skipped", async () => {
    await send(body("subscription.something_new")).expect(200);
    await vi.waitFor(() => logged("skipped"));
    expect(SubscriptionMock.findOneAndUpdate).not.toHaveBeenCalled();
  });

  it("a processing failure is recorded on the log and answered with 500 so Razorpay retries", async () => {
    SubscriptionMock.findOneAndUpdate.mockImplementation(() => {
      throw new Error("db write failed");
    });
    await send(body("subscription.activated")).expect(500);
    logged("failed", "db write failed");
    expect(upgradeStorage).not.toHaveBeenCalled();
  });

  it("re-processes a retried delivery whose earlier attempt FAILED (instead of ignoring it forever)", async () => {
    WebhookEventMock.create.mockRejectedValue(Object.assign(new Error("dup"), { code: 11000 }));
    WebhookEventMock.findOneAndUpdate.mockResolvedValue(logDoc);

    await send(body("subscription.activated")).expect(200);

    const [filter, update] = WebhookEventMock.findOneAndUpdate.mock.calls[0];
    expect(filter).toEqual({
      webhookKey: `subscription.activated:sub_1:${CREATED_AT}`,
      status: "failed",
    });
    expect(update).toEqual({ status: "received", error: null });
    expect(upgradeStorage).toHaveBeenCalledWith(userId, PLAN_ID);
    logged("processed");
  });
});

describe("POST /webhooks/razorpay — out-of-order delivery", () => {
  const EVENT_AT = new Date(CREATED_AT * 1000);

  it("only applies an event that is not older than the newest one already applied", async () => {
    await send(body("subscription.cancelled")).expect(200);
    const [filter, update] = SubscriptionMock.findOneAndUpdate.mock.calls[0];
    expect(filter.$or).toEqual([{ lastEventAt: null }, { lastEventAt: { $lte: EVENT_AT } }]);
    expect(update.lastEventAt).toEqual(EVENT_AT);
  });

  it("a STALE 'activated' (arriving after a newer event) does not re-open the plan or touch storage", async () => {
    SubscriptionMock.findOneAndUpdate.mockReturnValue(query(null)); // blocked by the guard…
    SubscriptionMock.exists.mockResolvedValue({ _id: oid() }); //      …but the subscription exists
    SubscriptionMock.findOne.mockReturnValue(query({ userId, planId: PLAN_ID, status: "cancelled" }));

    await send(body("subscription.activated")).expect(200);

    expect(upgradeStorage).not.toHaveBeenCalled();
    logged("processed"); // not flagged as an unknown subscription
  });

  it("…yet the payment in a stale event is still recorded (the money arrived)", async () => {
    SubscriptionMock.findOneAndUpdate.mockReturnValue(query(null));
    SubscriptionMock.exists.mockResolvedValue({ _id: oid() });
    SubscriptionMock.findOne.mockReturnValue(query({ userId, planId: PLAN_ID, status: "cancelled" }));

    await send(
      body("subscription.charged", {}, { payment: { entity: { id: "pay_late", amount: 16900, status: "captured" } } }),
    ).expect(200);

    expect(upgradeStorage).not.toHaveBeenCalled();
    expect(PaymentMock.findOneAndUpdate.mock.calls[0][0]).toEqual({ paymentId: "pay_late" });
  });

  it("a stale 'cancelled' does not stamp a cancellation date", async () => {
    SubscriptionMock.findOneAndUpdate.mockReturnValue(query(null));
    SubscriptionMock.exists.mockResolvedValue({ _id: oid() });
    SubscriptionMock.findOne.mockReturnValue(query({ userId, planId: PLAN_ID, status: "active" }));

    await send(body("subscription.cancelled")).expect(200);
    expect(SubscriptionMock.updateOne).not.toHaveBeenCalled();
  });

  it("a stale 'halted' does not downgrade a user who has since paid", async () => {
    SubscriptionMock.findOneAndUpdate.mockReturnValue(query(null));
    SubscriptionMock.exists.mockResolvedValue({ _id: oid() });
    SubscriptionMock.findOne.mockReturnValue(query({ userId, planId: PLAN_ID, status: "active" }));

    await send(body("subscription.halted")).expect(200);
    expect(downgradeStorage).not.toHaveBeenCalled();
  });
});

describe("POST /webhooks/razorpay — payment ledger (revenue)", () => {
  const chargedPayload = (paymentOverrides = {}) =>
    body(
      "subscription.charged",
      {},
      {
        payment: {
          entity: {
            id: "pay_9",
            amount: 16900,
            currency: "INR",
            status: "captured",
            method: "upi",
            fee: 400,
            tax: 61,
            created_at: 1_700_000_050,
            ...paymentOverrides,
          },
        },
        invoice: { entity: { id: "inv_9" } },
      },
    );

  it("subscription.charged → records the real amount paid, once per payment id", async () => {
    await send(chargedPayload()).expect(200);

    const [filter, update, options] = PaymentMock.findOneAndUpdate.mock.calls[0];
    expect(filter).toEqual({ paymentId: "pay_9" });
    expect(options).toEqual({ upsert: true });
    expect(update.$setOnInsert).toMatchObject({
      subscriptionId: "sub_1",
      userId,
      planId: PLAN_ID,
      planName: "Pro",
      cycle: "monthly",
      amountPaise: 16900, // what Razorpay really collected, not the catalogue price
      currency: "INR",
      status: "captured",
      refundedPaise: 0,
      source: "webhook",
    });
    expect(update.$setOnInsert.paidAt).toEqual(new Date(1_700_000_050 * 1000));
    expect(update.$set).toEqual({ method: "upi", feePaise: 400, taxPaise: 61, invoiceId: "inv_9" });
  });

  it("subscription.activated (the first payment) is recorded too", async () => {
    await send(
      body("subscription.activated", {}, { payment: { entity: { id: "pay_first", amount: 16900, status: "captured" } } }),
    ).expect(200);
    expect(PaymentMock.findOneAndUpdate.mock.calls[0][0]).toEqual({ paymentId: "pay_first" });
  });

  it("a replayed event can never reset refund totals (refund fields are insert-only)", async () => {
    await send(chargedPayload()).expect(200);
    const update = PaymentMock.findOneAndUpdate.mock.calls[0][1];
    expect(update.$set).not.toHaveProperty("refundedPaise");
    expect(update.$set).not.toHaveProperty("status");
    expect(update.$set).not.toHaveProperty("amountPaise");
  });

  it("grants premium BEFORE the ledger write, and fails (→ retry) if the ledger write breaks", async () => {
    PaymentMock.findOneAndUpdate.mockRejectedValue(new Error("ledger down"));
    await send(chargedPayload()).expect(500);
    expect(upgradeStorage).toHaveBeenCalledWith(userId, PLAN_ID);
    logged("failed", "ledger down");
  });

  it("an event with no payment entity still activates the plan, but is shouted about", async () => {
    await send(body("subscription.charged")).expect(200);
    expect(upgradeStorage).toHaveBeenCalledWith(userId, PLAN_ID);
    expect(PaymentMock.findOneAndUpdate).not.toHaveBeenCalled();
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining("backfill"));
    logged("processed");
  });

  it("does not count a payment that was not captured", async () => {
    await send(chargedPayload({ status: "authorized" })).expect(200);
    expect(PaymentMock.findOneAndUpdate).not.toHaveBeenCalled();
  });

  it("cancelling keeps the payments untouched and only stamps the cancellation", async () => {
    await send(body("subscription.cancelled")).expect(200);
    expect(PaymentMock.findOneAndUpdate).not.toHaveBeenCalled();
    expect(SubscriptionMock.findOneAndUpdate.mock.calls[0][1]).toMatchObject({
      status: "cancelled",
      cancelAtPeriodEnd: true,
    });
    // stamped only if the cancel click hasn't already recorded it
    expect(SubscriptionMock.updateOne).toHaveBeenCalledWith(
      { subscriptionId: "sub_1", cancelledAt: null },
      { cancelledAt: expect.any(Date) },
    );
  });
});

describe("POST /webhooks/razorpay — refunds", () => {
  const refund = (event = "refund.processed", overrides = {}) => ({
    event,
    created_at: CREATED_AT,
    payload: {
      refund: { entity: { id: "rfnd_1", payment_id: "pay_9", amount: 5000, created_at: 1_700_000_100, ...overrides } },
    },
  });

  it("refund.processed → subtracts the refund from that payment, once", async () => {
    PaymentMock.findOneAndUpdate.mockResolvedValue({ paymentId: "pay_9" });
    await send(refund()).expect(200);

    const [filter, pipeline, options] = PaymentMock.findOneAndUpdate.mock.calls[0];
    expect(filter).toEqual({ paymentId: "pay_9", "refunds.refundId": { $ne: "rfnd_1" } });
    expect(options).toMatchObject({ updatePipeline: true }); // Mongoose rejects pipeline updates without it
    expect(Array.isArray(pipeline)).toBe(true);
    expect(JSON.stringify(pipeline)).toContain("rfnd_1");
    expect(JSON.stringify(pipeline)).toContain("partially_refunded");
    logged("processed");
  });

  it("a refund that was already applied is skipped, not applied twice", async () => {
    PaymentMock.findOneAndUpdate.mockResolvedValue(null);
    PaymentMock.exists.mockResolvedValue({ _id: oid() });
    await send(refund()).expect(200);
    logged("skipped");
  });

  it("a refund for a payment we never recorded is flagged for the backfill", async () => {
    PaymentMock.findOneAndUpdate.mockResolvedValue(null);
    PaymentMock.exists.mockResolvedValue(null);
    await send(refund()).expect(200);
    expect(WebhookEventMock.findByIdAndUpdate).toHaveBeenCalledWith(logDoc._id, {
      status: "failed",
      error: expect.stringContaining("backfill"),
    });
  });

  it("refund.created (not yet processed) does not change revenue", async () => {
    await send(refund("refund.created")).expect(200);
    expect(PaymentMock.findOneAndUpdate).not.toHaveBeenCalled();
    logged("skipped");
  });

  it("a refund delivery is idempotent like every other event", async () => {
    WebhookEventMock.create.mockRejectedValue(Object.assign(new Error("dup"), { code: 11000 }));
    await send(refund()).expect(200);
    expect(PaymentMock.findOneAndUpdate).not.toHaveBeenCalled();
  });
});
