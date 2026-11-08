import { describe, it, expect } from "vitest";
import Subscription, { SUBSCRIPTION_STATUSES } from "../../../models/subscriptionModel.js";
import { oid } from "../../helpers/fixtures.js";
import { errorFields } from "../../helpers/validation.js";

const validData = () => ({
  subscriptionId: "sub_123",
  userId: oid(),
  planId: "plan_T7QOKw1SWn3YA9",
});

describe("Subscription model", () => {
  it("accepts a valid subscription and defaults to the 'created' status", async () => {
    const sub = new Subscription(validData());
    expect(await errorFields(sub)).toEqual([]);
    expect(sub.status).toBe("created");
    expect(sub.paidCount).toBe(0);
    expect(sub.currentEnd).toBeNull();
    expect(sub.lastPaymentId).toBeNull();
  });

  it("covers every Razorpay lifecycle status the webhook/cron code uses", async () => {
    expect(SUBSCRIPTION_STATUSES).toEqual(
      expect.arrayContaining([
        "created", "authenticated", "active", "pending",
        "halted", "paused", "cancelled", "completed", "expired",
      ]),
    );
  });

  it.each(SUBSCRIPTION_STATUSES)("accepts status %s", async (status) => {
    expect(await errorFields(new Subscription({ ...validData(), status }))).toEqual([]);
  });

  it("rejects an unknown status", async () => {
    const errors = await errorFields(new Subscription({ ...validData(), status: "refunded" }));
    expect(errors).toContain("status");
  });

  it.each(["subscriptionId", "userId", "planId"])("requires %s", async (field) => {
    const data = validData();
    delete data[field];
    expect((await errorFields(new Subscription(data)))).toContain(field);
  });

  it("keeps Razorpay subscription ids unique", async () => {
    expect(Subscription.schema.path("subscriptionId").options.unique).toBe(true);
  });
});
