import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import { loadApp, loginAs, request } from "../helpers/app.js";
import { SubscriptionMock, PaymentMock } from "../helpers/modelMocks.js";
import { query } from "../helpers/query.js";
import { hmacHex, oid } from "../helpers/fixtures.js";
import { upgradeStorage } from "../../services/storageService.js";

const { rzp } = vi.hoisted(() => ({
  rzp: {
    subscriptions: { create: vi.fn(), fetch: vi.fn(), cancel: vi.fn() },
    invoices: { all: vi.fn() },
  },
}));
vi.mock("razorpay", () => ({
  default: class {
    static validateWebhookSignature = vi.fn();
    constructor() {
      return rzp;
    }
  },
}));

const PLAN_ID = "plan_T7QOKw1SWn3YA9";
const DAY = 86_400_000;
const future = () => new Date(Date.now() + 10 * DAY);
const past = () => new Date(Date.now() - 10 * DAY);

let app;
let cookie;
let user;

beforeAll(async () => {
  app = await loadApp();
});

beforeEach(() => {
  ({ cookie, user } = loginAs());
  vi.spyOn(console, "error").mockImplementation(() => {});
});

const authed = (method, path) => request(app)[method](path).set("Cookie", cookie);

describe("POST /subscriptions (create)", () => {
  it("rejects unknown / tampered plan ids", async () => {
    const res = await authed("post", "/subscriptions").send({ planId: "plan_FAKE" }).expect(400);
    expect(res.body.error).toBe("Invalid plan selected.");
    expect(rzp.subscriptions.create).not.toHaveBeenCalled();
  });

  it("returns 409 when the user already has an active premium subscription", async () => {
    SubscriptionMock.findOne.mockReturnValueOnce(
      query({ status: "active", currentEnd: future() }),
    );
    const res = await authed("post", "/subscriptions").send({ planId: PLAN_ID }).expect(409);
    expect(res.body.error).toMatch(/already have an active subscription/i);
    expect(rzp.subscriptions.create).not.toHaveBeenCalled();
  });

  it("creates a Razorpay subscription and stores it locally", async () => {
    SubscriptionMock.findOne.mockReturnValue(query(null));
    rzp.subscriptions.create.mockResolvedValue({ id: "sub_new", status: "created" });

    const res = await authed("post", "/subscriptions").send({ planId: PLAN_ID }).expect(201);

    expect(res.body).toEqual({ subscriptionId: "sub_new" });
    expect(rzp.subscriptions.create).toHaveBeenCalledWith(
      expect.objectContaining({
        plan_id: PLAN_ID,
        total_count: 12,
        notes: { userId: user._id.toString() },
      }),
    );
    expect(SubscriptionMock.create).toHaveBeenCalledWith({
      subscriptionId: "sub_new",
      planId: PLAN_ID,
      userId: user._id,
      status: "created",
    });
  });

  it("starts fresh when the user's previous subscription has already ended", async () => {
    SubscriptionMock.findOne
      .mockReturnValueOnce(query({ status: "active", currentEnd: past() }))
      .mockReturnValueOnce(query(null));
    rzp.subscriptions.create.mockResolvedValue({ id: "sub_new", status: "created" });
    await authed("post", "/subscriptions").send({ planId: PLAN_ID }).expect(201);
  });

  it("reuses a checkout the user already started for the same plan (no duplicate Razorpay subscription)", async () => {
    SubscriptionMock.findOne
      .mockReturnValueOnce(query(null))
      .mockReturnValueOnce(
        query({ _id: oid(), subscriptionId: "sub_pending", planId: PLAN_ID }),
      );
    rzp.subscriptions.fetch.mockResolvedValue({ status: "created" });

    const res = await authed("post", "/subscriptions").send({ planId: PLAN_ID }).expect(200);

    expect(res.body).toEqual({ subscriptionId: "sub_pending" });
    expect(rzp.subscriptions.create).not.toHaveBeenCalled();
  });

  it("discards a stale local checkout that Razorpay no longer knows about", async () => {
    const stale = { _id: oid(), subscriptionId: "sub_gone" };
    SubscriptionMock.findOne
      .mockReturnValueOnce(query(null))
      .mockReturnValueOnce(query(stale));
    rzp.subscriptions.fetch.mockRejectedValue(new Error("not found"));
    rzp.subscriptions.create.mockResolvedValue({ id: "sub_new", status: "created" });

    await authed("post", "/subscriptions").send({ planId: PLAN_ID }).expect(201);

    expect(SubscriptionMock.deleteOne).toHaveBeenCalledWith({ _id: stale._id });
  });

  it("discards a local checkout whose Razorpay subscription moved on", async () => {
    const old = { _id: oid(), subscriptionId: "sub_old" };
    SubscriptionMock.findOne.mockReturnValueOnce(query(null)).mockReturnValueOnce(query(old));
    rzp.subscriptions.fetch.mockResolvedValue({ status: "cancelled" });
    rzp.subscriptions.create.mockResolvedValue({ id: "sub_new", status: "created" });

    await authed("post", "/subscriptions").send({ planId: PLAN_ID }).expect(201);

    expect(SubscriptionMock.deleteOne).toHaveBeenCalledWith({ _id: old._id });
  });

  describe("abandoned / in-flight checkouts", () => {
    const PRO = "plan_T7QOKw1SWn3YA9";
    const PREMIUM = "plan_T7QTobe7VSThyp";

    it("does NOT reopen an abandoned checkout for a different plan — it cancels it and opens the plan the user picked", async () => {
      const abandoned = { _id: oid(), subscriptionId: "sub_pro", planId: PRO };
      SubscriptionMock.findOne
        .mockReturnValueOnce(query(null))
        .mockReturnValueOnce(query(abandoned));
      rzp.subscriptions.fetch.mockResolvedValue({ status: "created" });
      rzp.subscriptions.cancel.mockResolvedValue({});
      rzp.subscriptions.create.mockResolvedValue({ id: "sub_premium", status: "created" });

      const res = await authed("post", "/subscriptions").send({ planId: PREMIUM }).expect(201);

      expect(res.body).toEqual({ subscriptionId: "sub_premium" });
      expect(rzp.subscriptions.cancel).toHaveBeenCalledWith("sub_pro"); // immediate, not at cycle end
      expect(SubscriptionMock.deleteOne).toHaveBeenCalledWith({ _id: abandoned._id });
      expect(rzp.subscriptions.create).toHaveBeenCalledWith(
        expect.objectContaining({ plan_id: PREMIUM }),
      );
      expect(SubscriptionMock.create).toHaveBeenCalledWith(
        expect.objectContaining({ subscriptionId: "sub_premium", planId: PREMIUM }),
      );
    });

    it("still opens the right plan when Razorpay refuses to cancel the abandoned checkout", async () => {
      const abandoned = { _id: oid(), subscriptionId: "sub_pro", planId: PRO };
      SubscriptionMock.findOne
        .mockReturnValueOnce(query(null))
        .mockReturnValueOnce(query(abandoned));
      rzp.subscriptions.fetch.mockResolvedValue({ status: "created" });
      rzp.subscriptions.cancel.mockRejectedValue(new Error("cannot cancel"));
      rzp.subscriptions.create.mockResolvedValue({ id: "sub_premium", status: "created" });
      vi.spyOn(console, "warn").mockImplementation(() => {});

      await authed("post", "/subscriptions").send({ planId: PREMIUM }).expect(201);

      expect(SubscriptionMock.deleteOne).toHaveBeenCalledWith({ _id: abandoned._id });
      expect(rzp.subscriptions.create).toHaveBeenCalledWith(
        expect.objectContaining({ plan_id: PREMIUM }),
      );
    });

    it.each(["authenticated", "active", "pending", "paused"])(
      "refuses to start another checkout while a paid-for one (%s on Razorpay) is still being processed — and keeps its record",
      async (rzpStatus) => {
        SubscriptionMock.findOne
          .mockReturnValueOnce(query(null))
          .mockReturnValueOnce(
            query({ _id: oid(), subscriptionId: "sub_paid", planId: PRO }),
          );
        rzp.subscriptions.fetch.mockResolvedValue({ status: rzpStatus });

        const res = await authed("post", "/subscriptions").send({ planId: PRO }).expect(409);

        expect(res.body.error).toMatch(/still being processed/i);
        expect(SubscriptionMock.deleteOne).not.toHaveBeenCalled();
        expect(rzp.subscriptions.cancel).not.toHaveBeenCalled();
        expect(rzp.subscriptions.create).not.toHaveBeenCalled();
      },
    );

    it("blocks a new checkout while a cancelled plan is still paid for", async () => {
      SubscriptionMock.findOne.mockReturnValueOnce(
        query({ status: "cancelled", currentEnd: future() }),
      );
      const res = await authed("post", "/subscriptions").send({ planId: PREMIUM }).expect(409);
      expect(res.body.error).toMatch(/stays active until it ends/i);
      expect(rzp.subscriptions.create).not.toHaveBeenCalled();
      expect(SubscriptionMock.findOne.mock.calls[0][0].status.$in).toContain("cancelled");
    });

    it("allows a new checkout once a cancelled plan's paid period has ended", async () => {
      SubscriptionMock.findOne
        .mockReturnValueOnce(query({ status: "cancelled", currentEnd: past() }))
        .mockReturnValueOnce(query(null));
      rzp.subscriptions.create.mockResolvedValue({ id: "sub_new", status: "created" });
      await authed("post", "/subscriptions").send({ planId: PREMIUM }).expect(201);
    });
  });

  it("returns a generic 500 when Razorpay fails", async () => {
    SubscriptionMock.findOne.mockReturnValue(query(null));
    rzp.subscriptions.create.mockRejectedValue(new Error("razorpay secret failure"));
    const res = await authed("post", "/subscriptions").send({ planId: PLAN_ID }).expect(500);
    expect(res.body.message).toBe("Internal Server Error");
  });
});

describe("GET /subscriptions/active", () => {
  it("returns null when the user never subscribed", async () => {
    SubscriptionMock.findOne.mockReturnValue(query(null));
    const res = await authed("get", "/subscriptions/active").expect(200);
    expect(res.body).toEqual({ subscription: null, isPremiumActive: false });
  });

  it("reports premium while the paid period has not ended", async () => {
    SubscriptionMock.findOne.mockReturnValue(
      query({ subscriptionId: "sub_1", status: "cancelled", currentEnd: future() }),
    );
    const res = await authed("get", "/subscriptions/active").expect(200);
    expect(res.body.isPremiumActive).toBe(true);
    expect(res.body.subscription.subscriptionId).toBe("sub_1");
  });

  it("describes the state to show: a cancelled-but-paid plan is 'cancelling', not 'cancelled'", async () => {
    SubscriptionMock.findOne.mockReturnValue(
      query({ subscriptionId: "sub_1", status: "cancelled", cancelledAt: new Date(), currentEnd: future() }),
    );
    const res = await authed("get", "/subscriptions/active").expect(200);
    expect(res.body.display).toMatchObject({ key: "cancelling", hasAccess: true, renews: false });
  });

  describe("when there is no current plan", () => {
    it("says what ended last, so the page can explain it", async () => {
      SubscriptionMock.findOne
        .mockReturnValueOnce(query(null)) // nothing live
        .mockReturnValueOnce(
          query({ subscriptionId: "sub_old", planId: PLAN_ID, status: "expired", cancelledAt: new Date(), endedAt: past() }),
        );
      const res = await authed("get", "/subscriptions/active").expect(200);
      expect(res.body.subscription).toBeNull();
      expect(res.body.isPremiumActive).toBe(false);
      expect(res.body.ended).toMatchObject({ subscriptionId: "sub_old", planId: PLAN_ID, reason: "cancelled" });
    });

    it("distinguishes a plan that lapsed from one the user cancelled", async () => {
      SubscriptionMock.findOne
        .mockReturnValueOnce(query(null))
        .mockReturnValueOnce(query({ subscriptionId: "sub_old", planId: PLAN_ID, status: "halted", endedAt: past() }));
      const res = await authed("get", "/subscriptions/active").expect(200);
      expect(res.body.ended.reason).toBe("halted");
    });

    it("only looks at plans the user actually paid for", async () => {
      SubscriptionMock.findOne.mockReturnValue(query(null));
      await authed("get", "/subscriptions/active").expect(200);
      expect(SubscriptionMock.findOne.mock.calls[1][0].paidCount).toEqual({ $gt: 0 });
    });

    it("treats a cancelled plan whose paid period is over as ended, even before the cron has run", async () => {
      SubscriptionMock.findOne
        .mockReturnValueOnce(query({ subscriptionId: "sub_1", planId: PLAN_ID, status: "cancelled", currentEnd: past() }))
        .mockReturnValueOnce(query({ subscriptionId: "sub_1", planId: PLAN_ID, status: "cancelled", currentEnd: past() }));
      const res = await authed("get", "/subscriptions/active").expect(200);
      expect(res.body.subscription).toBeNull();
      expect(res.body.ended).toMatchObject({ subscriptionId: "sub_1", reason: "cancelled" });
    });
  });

  it("reports no premium once the period has ended", async () => {
    SubscriptionMock.findOne.mockReturnValue(
      query({ subscriptionId: "sub_1", status: "active", currentEnd: past() }),
    );
    const res = await authed("get", "/subscriptions/active").expect(200);
    expect(res.body.isPremiumActive).toBe(false);
  });

  it("never returns an unfinished checkout (status created)", async () => {
    SubscriptionMock.findOne.mockReturnValue(query(null));
    await authed("get", "/subscriptions/active").expect(200);
    expect(SubscriptionMock.findOne.mock.calls[0][0].status.$in).not.toContain("created");
  });

  it("only looks up the logged-in user's subscriptions", async () => {
    SubscriptionMock.findOne.mockReturnValue(query(null));
    await authed("get", "/subscriptions/active").expect(200);
    expect(SubscriptionMock.findOne.mock.calls[0][0].userId).toBe(user._id);
  });
});

describe("POST /subscriptions/verify (payment signature)", () => {
  const fields = {
    razorpay_subscription_id: "sub_1",
    razorpay_payment_id: "pay_1",
  };
  const goodSignature = () => hmacHex("rzp_test_secret", "pay_1|sub_1");

  it("requires all three verification fields", async () => {
    const res = await authed("post", "/subscriptions/verify").send(fields).expect(400);
    expect(res.body.error).toBe("Missing verification fields.");
  });

  it("returns 404 when the subscription does not belong to the user", async () => {
    SubscriptionMock.findOne.mockReturnValue(query(null));
    await authed("post", "/subscriptions/verify")
      .send({ ...fields, razorpay_signature: goodSignature() })
      .expect(404);
    expect(SubscriptionMock.findOne).toHaveBeenCalledWith({
      subscriptionId: "sub_1",
      userId: user._id,
    });
  });

  it("rejects an invalid signature", async () => {
    SubscriptionMock.findOne.mockReturnValue(query({ subscriptionId: "sub_1" }));
    const res = await authed("post", "/subscriptions/verify")
      .send({ ...fields, razorpay_signature: "f".repeat(64) })
      .expect(400);
    expect(res.body.error).toBe("Invalid payment signature.");
  });

  it("confirms a genuine signature — without activating premium (the webhook does that)", async () => {
    SubscriptionMock.findOne.mockReturnValue(query({ subscriptionId: "sub_1" }));
    const res = await authed("post", "/subscriptions/verify")
      .send({ ...fields, razorpay_signature: goodSignature() })
      .expect(200);
    expect(res.body).toEqual({ verified: true });
    expect(upgradeStorage).not.toHaveBeenCalled();
    expect(SubscriptionMock.updateOne).not.toHaveBeenCalled();
  });
});

describe("POST /subscriptions/:subscriptionId/cancel", () => {
  it("rejects ids that are not Razorpay subscription ids", async () => {
    await authed("post", "/subscriptions/abc123/cancel").expect(400);
  });

  it("returns 404 for someone else's subscription", async () => {
    SubscriptionMock.findOne.mockReturnValue(query(null));
    await authed("post", "/subscriptions/sub_x/cancel").expect(404);
    expect(rzp.subscriptions.cancel).not.toHaveBeenCalled();
  });

  it.each(["cancelled", "expired", "halted", "paused"])(
    "returns 409 for a %s subscription",
    async (status) => {
      SubscriptionMock.findOne.mockReturnValue(query({ subscriptionId: "sub_x", status }));
      await authed("post", "/subscriptions/sub_x/cancel").expect(409);
      expect(rzp.subscriptions.cancel).not.toHaveBeenCalled();
    },
  );

  it("cancels an unpaid checkout immediately", async () => {
    SubscriptionMock.findOne.mockReturnValue(query({ subscriptionId: "sub_x", status: "created" }));
    rzp.subscriptions.cancel.mockResolvedValue({});
    const res = await authed("post", "/subscriptions/sub_x/cancel").expect(200);
    expect(rzp.subscriptions.cancel).toHaveBeenCalledWith("sub_x", false); // nothing paid → no cycle to wait for
    expect(res.body.message).toBe("Subscription cancelled.");
  });

  it("cancels an active subscription at the end of the billing cycle", async () => {
    SubscriptionMock.findOne.mockReturnValue(query({ subscriptionId: "sub_x", status: "active" }));
    rzp.subscriptions.cancel.mockResolvedValue({});
    const res = await authed("post", "/subscriptions/sub_x/cancel").expect(200);
    expect(rzp.subscriptions.cancel).toHaveBeenCalledWith("sub_x", true); // at the end of the paid cycle
    expect(res.body.message).toMatch(/retain premium access/i);
    expect(SubscriptionMock.updateOne).toHaveBeenCalledWith(
      { subscriptionId: "sub_x", userId: user._id },
      { status: "cancelled", cancelledAt: expect.any(Date), cancelAtPeriodEnd: true, lastEventAt: expect.any(Date) },
    );
  });

  it("an unpaid checkout is cancelled right away, not 'at period end'", async () => {
    SubscriptionMock.findOne.mockReturnValue(query({ subscriptionId: "sub_x", status: "created" }));
    rzp.subscriptions.cancel.mockResolvedValue({});
    await authed("post", "/subscriptions/sub_x/cancel").expect(200);
    expect(SubscriptionMock.updateOne.mock.calls[0][1]).toMatchObject({
      status: "cancelled",
      cancelAtPeriodEnd: false,
    });
  });

  it.each(["authenticated", "pending"])(
    "a %s plan has no paid cycle to wait for, so Razorpay cancels it immediately",
    async (status) => {
      SubscriptionMock.findOne.mockReturnValue(query({ subscriptionId: "sub_x", status }));
      rzp.subscriptions.cancel.mockResolvedValue({});
      await authed("post", "/subscriptions/sub_x/cancel").expect(200);
      expect(rzp.subscriptions.cancel).toHaveBeenCalledWith("sub_x", false);
    },
  );

  it("syncs instead of failing when it was already cancelled on Razorpay's side", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    SubscriptionMock.findOne.mockReturnValue(query({ subscriptionId: "sub_x", status: "active" }));
    rzp.subscriptions.cancel.mockRejectedValue(new Error("already cancelled"));
    rzp.subscriptions.fetch.mockResolvedValue({ status: "cancelled" });

    await authed("post", "/subscriptions/sub_x/cancel").expect(200);
    expect(SubscriptionMock.updateOne.mock.calls[0][1]).toMatchObject({ status: "cancelled" });
  });

  it("does not mark the subscription cancelled locally when Razorpay fails", async () => {
    SubscriptionMock.findOne.mockReturnValue(query({ subscriptionId: "sub_x", status: "active" }));
    rzp.subscriptions.cancel.mockRejectedValue(new Error("rzp down"));
    await authed("post", "/subscriptions/sub_x/cancel").expect(500);
    expect(SubscriptionMock.updateOne).not.toHaveBeenCalled();
  });
});

describe("GET /subscriptions/:subscriptionId/payment-method/update-link", () => {
  it("validates the id and ownership", async () => {
    await authed("get", "/subscriptions/abc/payment-method/update-link").expect(400);
    SubscriptionMock.findOne.mockReturnValue(query(null));
    await authed("get", "/subscriptions/sub_x/payment-method/update-link").expect(404);
  });

  it("refuses for subscriptions in a non-updatable state", async () => {
    SubscriptionMock.findOne.mockReturnValue(query({ subscriptionId: "sub_x", status: "created" }));
    await authed("get", "/subscriptions/sub_x/payment-method/update-link").expect(409);
  });

  it("returns Razorpay's hosted update URL", async () => {
    SubscriptionMock.findOne.mockReturnValue(query({ subscriptionId: "sub_x", status: "active" }));
    rzp.subscriptions.fetch.mockResolvedValue({ short_url: "https://rzp.io/i/abc" });
    const res = await authed("get", "/subscriptions/sub_x/payment-method/update-link").expect(200);
    expect(res.body).toEqual({ updateUrl: "https://rzp.io/i/abc" });
  });
});

describe("GET /subscriptions/:subscriptionId/payments", () => {
  it("validates the id and ownership", async () => {
    await authed("get", "/subscriptions/abc/payments").expect(400);
    SubscriptionMock.findOne.mockReturnValue(query(null));
    await authed("get", "/subscriptions/sub_x/payments").expect(404);
  });

  it("maps Razorpay invoices (paise → rupees, epoch → ISO date)", async () => {
    SubscriptionMock.findOne.mockReturnValue(
      query({ subscriptionId: "sub_x", paymentMethod: "card" }),
    );
    rzp.invoices.all.mockResolvedValue({
      items: [
        { id: "inv_1", amount: 16900, status: "paid", created_at: 1_700_000_000, short_url: "https://rzp.io/inv_1" },
        { id: "inv_2", amount: 49900, status: "issued", created_at: 1_702_000_000 },
      ],
    });

    const res = await authed("get", "/subscriptions/sub_x/payments").expect(200);

    expect(rzp.invoices.all).toHaveBeenCalledWith({ subscription_id: "sub_x" });
    expect(res.body.payments).toEqual([
      {
        invoiceId: "inv_1",
        amount: 169,
        paymentMethod: "card",
        status: "paid",
        createdAt: new Date(1_700_000_000 * 1000).toISOString(),
        invoiceUrl: "https://rzp.io/inv_1",
      },
      {
        invoiceId: "inv_2",
        amount: 499,
        paymentMethod: "card",
        status: "issued",
        createdAt: new Date(1_702_000_000 * 1000).toISOString(),
        invoiceUrl: null,
      },
    ]);
  });

  it("returns an empty list when there are no invoices", async () => {
    SubscriptionMock.findOne.mockReturnValue(query({ subscriptionId: "sub_x" }));
    rzp.invoices.all.mockResolvedValue({});
    const res = await authed("get", "/subscriptions/sub_x/payments").expect(200);
    expect(res.body.payments).toEqual([]);
  });
});

describe("GET /subscriptions/payments (billing history)", () => {
  const row = (overrides = {}) => ({
    paymentId: "pay_1",
    subscriptionId: "sub_1",
    invoiceId: "inv_1",
    amountPaise: 16900,
    refundedPaise: 0,
    status: "captured",
    method: "upi",
    planName: "Pro",
    cycle: "monthly",
    paidAt: new Date("2026-10-01T00:00:00Z"),
    ...overrides,
  });

  it("lists the user's payments from the ledger (all subscriptions), newest first", async () => {
    PaymentMock.find.mockReturnValue(query([row(), row({ paymentId: "pay_0", subscriptionId: "sub_0", invoiceId: "inv_0" })]));
    rzp.invoices.all.mockResolvedValue({ items: [{ id: "inv_1", short_url: "https://rzp.io/i/abc" }] });

    const res = await authed("get", "/subscriptions/payments").expect(200);

    expect(PaymentMock.find).toHaveBeenCalledWith({ userId: user._id });
    expect(res.body.payments).toHaveLength(2);
    expect(res.body.payments[0]).toMatchObject({
      paymentId: "pay_1",
      amount: 169,
      refundedAmount: 0,
      status: "captured",
      paymentMethod: "upi",
      planName: "Pro",
      invoiceUrl: "https://rzp.io/i/abc",
    });
    // a payment with no matching invoice link still comes back
    expect(res.body.payments[1].invoiceUrl).toBeNull();
  });

  it("still returns the history when Razorpay can't be reached for invoice links", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    PaymentMock.find.mockReturnValue(query([row()]));
    rzp.invoices.all.mockRejectedValue(new Error("rzp down"));

    const res = await authed("get", "/subscriptions/payments").expect(200);
    expect(res.body.payments[0]).toMatchObject({ amount: 169, invoiceUrl: null });
  });

  it("returns an empty list for someone who never paid", async () => {
    PaymentMock.find.mockReturnValue(query([]));
    const res = await authed("get", "/subscriptions/payments").expect(200);
    expect(res.body.payments).toEqual([]);
    expect(rzp.invoices.all).not.toHaveBeenCalled();
  });

  it("reports a failure through the error handler", async () => {
    PaymentMock.find.mockImplementation(() => { throw new Error("db down"); });
    await authed("get", "/subscriptions/payments").expect(500);
  });
});
