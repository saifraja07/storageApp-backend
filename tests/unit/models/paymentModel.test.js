import { describe, it, expect } from "vitest";
import Payment, { PAYMENT_STATUSES } from "../../../models/paymentModel.js";
import { oid } from "../../helpers/fixtures.js";
import { errorFields } from "../../helpers/validation.js";

const validData = () => ({
  paymentId: "pay_123",
  subscriptionId: "sub_123",
  userId: oid(),
  planId: "plan_T7QOKw1SWn3YA9",
  amountPaise: 16900,
  paidAt: new Date("2026-11-01T00:00:00Z"),
});

describe("Payment model", () => {
  it("accepts a valid payment and defaults to captured, INR, no refunds", async () => {
    const p = new Payment(validData());
    expect(await errorFields(p)).toEqual([]);
    expect(p.status).toBe("captured");
    expect(p.currency).toBe("INR");
    expect(p.refundedPaise).toBe(0);
    expect(p.refunds).toHaveLength(0);
    expect(p.source).toBe("webhook");
  });

  it.each(["paymentId", "subscriptionId", "userId", "planId", "amountPaise", "paidAt"])(
    "requires %s",
    async (field) => {
      const data = validData();
      delete data[field];
      expect(await errorFields(new Payment(data))).toContain(field);
    },
  );

  it.each(PAYMENT_STATUSES)("accepts status %s", async (status) => {
    expect(await errorFields(new Payment({ ...validData(), status }))).toEqual([]);
  });

  it("rejects an unknown status and negative amounts", async () => {
    expect(await errorFields(new Payment({ ...validData(), status: "failed" }))).toContain("status");
    expect(await errorFields(new Payment({ ...validData(), amountPaise: -1 }))).toContain("amountPaise");
  });

  it("keeps payments unique per Razorpay payment id", () => {
    const idx = Payment.schema.indexes().find(([fields]) => fields.paymentId);
    expect(idx[1].unique).toBe(true);
  });
});
