import express from "express";
import {
  createSubscription,
  getActiveSubscription,
  cancelSubscription,
  getUpdatePaymentLink,
  getPaymentHistory,
  getMyPayments,
  verifySubscription,
} from "../controllers/subscriptionController.js";
import { rateLimiter } from "../middleWares/limiterMiddleware.js";

const router = express.Router();

// ── Static / literal-segment routes FIRST ────────────────────────────────────
// These must come before any /:param routes so Express doesn't swallow them.

router.get("/active", getActiveSubscription);

// The customer's whole billing history (all subscriptions, from our payment ledger)
router.get("/payments", rateLimiter(15 * 60 * 1000, 20), getMyPayments);

// Verify Razorpay signature after checkout — does NOT activate premium
router.post(
  "/verify",
  rateLimiter(15 * 60 * 1000, 10),
  verifySubscription,
);

// ── Dynamic / :param routes ───────────────────────────────────────────────────

// Tight rate-limit on subscription creation — 5 attempts per 15 min per IP
router.post(
  "/",
  rateLimiter(15 * 60 * 1000, 5),
  createSubscription
);

// Cancel is user-initiated — a generous limit is fine
router.post(
  "/:subscriptionId/cancel",
  rateLimiter(15 * 60 * 1000, 10),
  cancelSubscription
);

// Returns the Razorpay-hosted URL where the user can update their payment method
router.get(
  "/:subscriptionId/payment-method/update-link",
  rateLimiter(15 * 60 * 1000, 10),
  getUpdatePaymentLink
);

// Payment history for a subscription
router.get(
  "/:subscriptionId/payments",
  rateLimiter(15 * 60 * 1000, 20),
  getPaymentHistory
);

export default router;
