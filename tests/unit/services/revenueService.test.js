import { describe, it, expect, vi } from "vitest";
import { PaymentMock } from "../../helpers/modelMocks.js";
import {
  computeMrr,
  getRevenueSummary,
  istMonthKey,
  lastMonthKeys,
} from "../../../services/revenueService.js";

vi.mock("../../../models/paymentModel.js", async () => ({
  default: (await import("../../helpers/modelMocks.js")).PaymentMock,
}));

describe("istMonthKey", () => {
  it("uses the IST calendar, not UTC", () => {
    // 31 Oct 2026 20:00 UTC is already 1 Nov in India
    expect(istMonthKey(new Date("2026-10-31T20:00:00Z"))).toBe("2026-11");
    expect(istMonthKey(new Date("2026-10-31T10:00:00Z"))).toBe("2026-10");
  });
});

describe("lastMonthKeys", () => {
  it("returns the last N months oldest-first and crosses year boundaries", () => {
    expect(lastMonthKeys(new Date("2026-02-10T00:00:00Z"), 4)).toEqual(["2025-11", "2025-12", "2026-01", "2026-02"]);
  });
});

describe("getRevenueSummary", () => {
  const now = new Date("2026-11-11T06:00:00Z");

  it("only counts payments that were actually received", async () => {
    PaymentMock.aggregate.mockResolvedValue([]);
    await getRevenueSummary(now);
    const [{ $match }] = PaymentMock.aggregate.mock.calls[0][0];
    expect($match.status.$in).toEqual(["captured", "partially_refunded", "refunded"]);
  });

  it("is zero for a business with no payments yet", async () => {
    PaymentMock.aggregate.mockResolvedValue([]);
    const r = await getRevenueSummary(now);
    expect(r).toMatchObject({ lifetime: 0, thisMonth: 0, lastMonth: 0, totalPayments: 0 });
    expect(r.byMonth).toHaveLength(6);
    expect(r.byMonth.every((m) => m.revenue === 0)).toBe(true);
  });

  it("totals lifetime / this month / last month net of refunds, in rupees", async () => {
    PaymentMock.aggregate.mockResolvedValue([
      { _id: "2026-11", grossPaise: 16900 + 49900, refundedPaise: 0, payments: 2 },
      { _id: "2026-10", grossPaise: 159900, refundedPaise: 50000, payments: 1 },
      { _id: "2025-03", grossPaise: 16900, refundedPaise: 0, payments: 1 }, // older than the 6-month chart
    ]);
    const r = await getRevenueSummary(now);

    expect(r.thisYear).toBe(668 + 1099); // 2026 only, net of refunds; 2025 excluded
    expect(r.thisMonth).toBe(668);
    expect(r.lastMonth).toBe(1099); // 1599 − 500 refunded
    expect(r.grossLifetime).toBe(668 + 1599 + 169);
    expect(r.refundedLifetime).toBe(500);
    expect(r.lifetime).toBe(668 + 1599 + 169 - 500);
    expect(r.totalPayments).toBe(4);
    // the old month counts towards lifetime but is outside the trend window
    expect(r.byMonth.map((m) => m.month)).toEqual(["2026-06", "2026-07", "2026-08", "2026-09", "2026-10", "2026-11"]);
    expect(r.byMonth.at(-1)).toEqual({ month: "2026-11", revenue: 668, payments: 2 });
  });
});

describe("computeMrr", () => {
  it("adds monthly plans and spreads yearly plans over 12 months", () => {
    const mrr = computeMrr([
      { planId: "plan_T7QOKw1SWn3YA9" }, // Pro monthly 169
      { planId: "plan_T7QV7r2nId24Vo" }, // Premium yearly 4999 → 416.58/mo
    ]);
    expect(mrr).toBeCloseTo(169 + 4999 / 12, 2);
  });

  it("ignores unknown plans and is 0 with no subscriptions", () => {
    expect(computeMrr([{ planId: "plan_unknown" }])).toBe(0);
    expect(computeMrr([])).toBe(0);
  });
});
