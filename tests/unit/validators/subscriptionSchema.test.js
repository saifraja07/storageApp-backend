import { describe, it, expect } from "vitest";
import { createSubscriptionSchema, PLAN_IDS } from "../../../validators/subscriptionSchema.js";

describe("createSubscriptionSchema", () => {
  it.each(PLAN_IDS)("accepts the known plan %s", (planId) => {
    expect(createSubscriptionSchema.safeParse({ planId }).success).toBe(true);
  });
  it("rejects tampered or unknown plan ids", () => {
    const r = createSubscriptionSchema.safeParse({ planId: "plan_FAKE" });
    expect(r.success).toBe(false);
    expect(r.error.issues[0].message).toBe("Invalid plan selected.");
  });
  it("rejects a missing plan id", () => {
    expect(createSubscriptionSchema.safeParse({}).success).toBe(false);
  });
});
