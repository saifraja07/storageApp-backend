import { PLAN_DETAILS } from "../config/plans.js";
import redisClient from "../config/redis.js";
import Subscription from "../models/subscriptionModel.js";
import User from "../models/userModel.js";
import { createR2UsageSnapshotService } from "../services/r2UsageSnapshotService.js";
import { isPremiumActive } from "../utils/isPremiumActive.js";
import { getSubscriptionDisplay } from "../utils/subscriptionDisplay.js";
import { computeMrr, getRevenueSummary } from "../services/revenueService.js";

// An abandoned checkout ("created") is not a plan, so it never masks a real one.
const LIVE_SUBSCRIPTION_STATUSES = [
    "authenticated",
    "active",
    "pending",
    "paused",
    "cancelled",
];

const r2UsageService = createR2UsageSnapshotService({ redis: redisClient });

export const getStorageUsage = async (req, res, next) => {
    try {
        const snapshot = await r2UsageService.getUsage();
        res.set("Cache-Control", "no-store");
        return res.json(snapshot);
    } catch (err) {
        next(err);
    }
};

export const refreshStorageUsage = async (req, res, next) => {
    try {
        const snapshot = await r2UsageService.getUsage({ force: true });
        res.set("Cache-Control", "no-store");
        return res.json(snapshot);
    } catch (err) {
        next(err);
    }
};

export const getPlansDashboard = async (req, res, next) => {
    try {
        const now = new Date();

        const [
            totalUsers,
            latestSubsPerUser,
            recentSubsRaw,
            storageAlertRows,
            revenue,
        ] = await Promise.all([
            User.countDocuments(),

            // Latest subscription per user (only "live" statuses), newest first.
            Subscription.aggregate([
                { $match: { status: { $in: LIVE_SUBSCRIPTION_STATUSES } } },
                { $sort: { createdAt: -1 } },
                { $group: { _id: "$userId", doc: { $first: "$$ROOT" } } },
                { $replaceRoot: { newRoot: "$doc" } },
            ]),

            // Most recent real subscription activity. Unfinished checkouts and
            // subscriptions cancelled before ever being paid are noise, not activity.
            Subscription.find({
                status: { $ne: "created" },
                $nor: [{ status: "cancelled", paidCount: 0 }],
            })
                .sort({ createdAt: -1 })
                .limit(10)
                .populate("userId", "name email picture")
                .lean(),

            // Top 6 users closest to running out of storage — ranked in the
            // database instead of loading every user into memory.
            User.aggregate([
                { $match: { maxStorageInBytes: { $gt: 0 }, isDeleted: { $ne: true } } },
                {
                    $addFields: {
                        percentUsed: {
                            $min: [
                                100,
                                {
                                    $multiply: [
                                        { $divide: [{ $ifNull: ["$usedStorageInBytes", 0] }, "$maxStorageInBytes"] },
                                        100,
                                    ],
                                },
                            ],
                        },
                    },
                },
                { $sort: { percentUsed: -1 } },
                { $limit: 6 },
                { $project: { name: 1, email: 1, picture: 1, usedStorageInBytes: 1, maxStorageInBytes: 1, percentUsed: 1 } },
            ]),

            // Money actually received — comes from the payment ledger, so it
            // does not depend on what state any subscription is in today.
            getRevenueSummary(now),
        ]);

        // Hydrate user info (and storage) for the per-user latest-subscription list.
        const userIds = latestSubsPerUser.map((s) => s.userId);
        const subUsers = await User.find({ _id: { $in: userIds } })
            .select("name email picture isDeleted maxStorageInBytes usedStorageInBytes")
            .lean();
        const userById = new Map(subUsers.map((u) => [u._id.toString(), u]));

        const activePlans = [];
        const renewingSubs = [];
        let premiumUsers = 0;
        let cancellingUsers = 0;
        let pastDueUsers = 0;
        let expiringSoon = 0;
        const WEEK = 7 * 24 * 60 * 60 * 1000;

        for (const sub of latestSubsPerUser) {
            const owner = userById.get(sub.userId?.toString());
            if (!owner || owner.isDeleted) continue;
            if (!isPremiumActive(sub)) continue;

            const planInfo = PLAN_DETAILS[sub.planId] || null;
            const display = getSubscriptionDisplay(sub);

            premiumUsers += 1;
            if (display.key === "cancelling") cancellingUsers += 1;
            if (display.key === "past_due") pastDueUsers += 1;
            // access ends on its own (cancelled / paused) within a week
            if (!display.renews && display.key !== "activating" && new Date(sub.currentEnd) - now <= WEEK) expiringSoon += 1;
            // Only customers who will pay again count towards recurring revenue.
            if (display.key === "active") renewingSubs.push(sub);

            activePlans.push({
                id: owner._id,
                name: owner.name,
                email: owner.email,
                picture: owner.picture,
                planName: planInfo?.name || "Unknown",
                cycle: planInfo?.cycle === "yearly" ? "Yearly" : "Monthly",
                status: sub.status,
                displayStatus: display.key,
                displayLabel: display.label,
                renews: display.renews,
                usedStorageInBytes: owner.usedStorageInBytes ?? 0,
                maxStorageInBytes: owner.maxStorageInBytes ?? 0,
                renewalDate: sub.currentEnd,
                cancelledAt: sub.cancelledAt ?? null,
            });
        }

        activePlans.sort((a, b) => new Date(a.renewalDate) - new Date(b.renewalDate));

        const storageAlerts = storageAlertRows.map((u) => ({
            id: u._id,
            name: u.name,
            email: u.email,
            picture: u.picture,
            usedStorageInBytes: u.usedStorageInBytes || 0,
            maxStorageInBytes: u.maxStorageInBytes,
            percentUsed: u.percentUsed,
        }));

        const recentSubscriptions = recentSubsRaw
            .filter((s) => s.userId)
            .map((s) => {
                const planInfo = PLAN_DETAILS[s.planId] || null;
                const display = getSubscriptionDisplay(s);
                return {
                    id: s._id,
                    name: s.userId.name,
                    email: s.userId.email,
                    picture: s.userId.picture,
                    planName: planInfo?.name || "Unknown",
                    cycle: planInfo?.cycle === "yearly" ? "Yearly" : "Monthly",
                    status: s.status,
                    displayStatus: display.key,
                    displayLabel: display.label,
                    createdAt: s.createdAt,
                    cancelledAt: s.cancelledAt ?? null,
                    accessUntil: s.currentEnd ?? null,
                };
            });

        const mrr = computeMrr(renewingSubs);

        return res.json({
            summary: {
                totalUsers,
                // everyone with paid access right now (including cancelled-but-paid-up)
                premiumUsers,
                // paying customers who will be charged again
                payingSubscribers: renewingSubs.length,
                // cancelled, but still inside the period they paid for
                cancellingUsers,
                pastDueUsers,
                expiringSoon,

                // ── money actually received (₹, net of refunds) ──
                lifetimeRevenue: revenue.lifetime,
                revenueThisMonth: revenue.thisMonth,
                revenueLastMonth: revenue.lastMonth,
                revenueThisYear: revenue.thisYear,
                refundedTotal: revenue.refundedLifetime,
                totalPayments: revenue.totalPayments,

                // ── recurring revenue from customers who will renew ──
                mrr,
            },
            activePlans,
            storageAlerts,
            recentSubscriptions,
        });
    } catch (err) {
        next(err);
    }
};
