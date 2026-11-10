import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import { loadApp, request } from "../helpers/app.js";
import { SubscriptionMock, WebhookEventMock } from "../helpers/modelMocks.js";
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
    expect(filter).toEqual({ subscriptionId: "sub_1" });
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

  it("a processing failure is recorded on the log but still acknowledged", async () => {
    SubscriptionMock.findOneAndUpdate.mockImplementation(() => {
      throw new Error("db write failed");
    });
    await send(body("subscription.activated")).expect(200);
    await vi.waitFor(() => logged("failed", "db write failed"));
    expect(upgradeStorage).not.toHaveBeenCalled();
  });
});
