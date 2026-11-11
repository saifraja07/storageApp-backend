import { isPremiumActive } from "./isPremiumActive.js";

// Raw Razorpay statuses ("authenticated", "halted", "created"…) are plumbing.
// This turns a subscription into the state a customer or an admin should see,
// the way billing dashboards (Stripe, Netflix…) do:
//
//   active      paying, renews on `accessUntil`
//   activating  paid, first charge still being confirmed
//   cancelling  cancelled, but already-paid access runs until `accessUntil`
//   cancelled   cancelled and the paid period is over
//   past_due    last charge failed, Razorpay is retrying (access continues)
//   paused      auto-renewal paused (access continues until `accessUntil`)
//   halted      retries exhausted — ended
//   expired     ran out without being cancelled
//   completed   every billing cycle was fulfilled
//   incomplete  checkout never finished (never shown to people)
export const DISPLAY_LABELS = {
  active: "Active",
  activating: "Activating",
  cancelling: "Cancelling",
  cancelled: "Cancelled",
  past_due: "Payment failed",
  paused: "Paused",
  halted: "Ended · payment failed",
  expired: "Expired",
  completed: "Completed",
  incomplete: "Incomplete",
};

export function getSubscriptionDisplay(subscription) {
  if (!subscription) return null;

  const hasAccess = isPremiumActive(subscription);
  const accessUntil = subscription.currentEnd ?? null;
  const wasCancelled = !!subscription.cancelledAt || subscription.cancelAtPeriodEnd === true;

  let key;
  switch (subscription.status) {
    case "created":
      key = "incomplete";
      break;
    case "authenticated":
      key = hasAccess ? "active" : "activating";
      break;
    case "active":
      key = subscription.cancelAtPeriodEnd ? "cancelling" : "active";
      break;
    case "cancelled":
      key = hasAccess ? "cancelling" : "cancelled";
      break;
    case "pending":
      key = "past_due";
      break;
    case "paused":
      key = "paused";
      break;
    case "halted":
      key = "halted";
      break;
    case "expired":
      key = wasCancelled ? "cancelled" : "expired";
      break;
    case "completed":
      key = "completed";
      break;
    default:
      key = "incomplete";
  }

  return {
    key,
    label: DISPLAY_LABELS[key],
    hasAccess,
    // true when this plan will charge the customer again
    renews: key === "active" || key === "past_due",
    accessUntil,
  };
}
