import { describe, it, expect } from "vitest";
import { getSubscriptionDisplay, DISPLAY_LABELS } from "../../../utils/subscriptionDisplay.js";

const DAY = 86_400_000;
const future = () => new Date(Date.now() + 10 * DAY);
const past = () => new Date(Date.now() - 10 * DAY);

describe("getSubscriptionDisplay", () => {
  it("is null without a subscription", () => {
    expect(getSubscriptionDisplay(null)).toBeNull();
  });

  it.each([
    // [description, subscription, expected key, access, renews]
    ["an active, renewing plan", { status: "active", currentEnd: future() }, "active", true, true],
    ["active but set to cancel at period end", { status: "active", cancelAtPeriodEnd: true, currentEnd: future() }, "cancelling", true, false],
    ["cancelled with paid time left", { status: "cancelled", currentEnd: future() }, "cancelling", true, false],
    ["cancelled and the paid period is over", { status: "cancelled", currentEnd: past() }, "cancelled", false, false],
    ["expired after the user had cancelled", { status: "expired", cancelledAt: new Date(), currentEnd: past() }, "cancelled", false, false],
    ["expired without ever being cancelled", { status: "expired", currentEnd: past() }, "expired", false, false],
    ["a failed charge still inside the paid period", { status: "pending", currentEnd: future() }, "past_due", true, true],
    ["paused auto-renewal", { status: "paused", currentEnd: future() }, "paused", true, false],
    ["paid, first charge not confirmed yet", { status: "authenticated", currentEnd: null }, "activating", false, false],
    ["retries exhausted", { status: "halted", currentEnd: past() }, "halted", false, false],
    ["every cycle fulfilled", { status: "completed", currentEnd: past() }, "completed", false, false],
    ["an unfinished checkout", { status: "created" }, "incomplete", false, false],
  ])("%s", (_name, sub, key, hasAccess, renews) => {
    const d = getSubscriptionDisplay(sub);
    expect(d.key).toBe(key);
    expect(d.label).toBe(DISPLAY_LABELS[key]);
    expect(d.hasAccess).toBe(hasAccess);
    expect(d.renews).toBe(renews);
  });

  it("exposes when access ends", () => {
    const currentEnd = future();
    expect(getSubscriptionDisplay({ status: "cancelled", currentEnd }).accessUntil).toBe(currentEnd);
  });
});
