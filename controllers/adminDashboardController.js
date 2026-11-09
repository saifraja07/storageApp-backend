import { PLAN_DETAILS } from "../config/plans.js";
import redisClient from "../config/redis.js";
import Subscription from "../models/subscriptionModel.js";
import User from "../models/userModel.js";
import { createR2UsageSnapshotService } from "../services/r2UsageSnapshotService.js";
import { isPremiumActive } from "../utils/isPremiumActive.js";

const LIVE_SUBSCRIPTION_STATUSES = [
    "created",
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
        const [totalUsers, latestSubsPerUser, recentSubsRaw, storageUsers] = await Promise.all([
            User.countDocuments(),

            // Latest subscription per user (only "live" statuses), newest first.
            Subscription.aggregate([
                { $match: { status: { $in: LIVE_SUBSCRIPTION_STATUSES } } },
                { $sort: { createdAt: -1 } },
                { $group: { _id: "$userId", doc: { $first: "$$ROOT" } } },
                { $replaceRoot: { newRoot: "$doc" } },
            ]),

            // Most recent subscription activity overall, regardless of user.
            Subscription.find()
                .sort({ createdAt: -1 })
                .limit(10)
                .populate("userId", "name email picture")
                .lean(),

            User.find()
                .select("name email picture maxStorageInBytes usedStorageInBytes")
                .lean(),
        ]);

        // Hydrate user info for the per-user latest-subscription list.
        const userIds = latestSubsPerUser.map((s) => s.userId);
        const subUsers = await User.find({ _id: { $in: userIds } })
            .select("name email picture isDeleted")
            .lean();
        const userById = new Map(subUsers.map((u) => [u._id.toString(), u]));
        const storageByUserId = new Map(storageUsers.map((u) => [u._id.toString(), u]));

        const activePlans = [];
        let monthlyRevenue = 0;
        let yearlyRevenue = 0;
        let premiumUsers = 0;

        for (const sub of latestSubsPerUser) {
            const owner = userById.get(sub.userId?.toString());
            if (!owner || owner.isDeleted) continue;

            const planInfo = PLAN_DETAILS[sub.planId] || null;
            const premiumActive = isPremiumActive(sub);

            if (premiumActive) {
                premiumUsers += 1;
                const storageInfo = storageByUserId.get(owner._id.toString());
                activePlans.push({
                    id: owner._id,
                    name: owner.name,
                    email: owner.email,
                    picture: owner.picture,
                    planName: planInfo?.name || "Unknown",
                    cycle: planInfo?.cycle === "yearly" ? "Yearly" : "Monthly",
                    status: sub.status,
                    usedStorageInBytes: storageInfo?.usedStorageInBytes ?? 0,
                    maxStorageInBytes: storageInfo?.maxStorageInBytes ?? 0,
                    renewalDate: sub.currentEnd,
                });
            }

            // Revenue counts only subscriptions actively billing right now.
            if (sub.status === "active" && planInfo) {
                if (planInfo.cycle === "yearly") yearlyRevenue += planInfo.price;
                else monthlyRevenue += planInfo.price;
            }
        }

        activePlans.sort((a, b) => new Date(a.renewalDate) - new Date(b.renewalDate));

        // Top 5 users closest to running out of storage.
        const storageAlerts = storageUsers
            .filter((u) => u.maxStorageInBytes > 0)
            .map((u) => ({
                id: u._id,
                name: u.name,
                email: u.email,
                picture: u.picture,
                usedStorageInBytes: u.usedStorageInBytes || 0,
                maxStorageInBytes: u.maxStorageInBytes,
                percentUsed: Math.min(
                    ((u.usedStorageInBytes || 0) / u.maxStorageInBytes) * 100,
                    100
                ),
            }))
            .sort((a, b) => b.percentUsed - a.percentUsed)
            .slice(0, 6);

        const recentSubscriptions = recentSubsRaw
            .filter((s) => s.userId)
            .map((s) => {
                const planInfo = PLAN_DETAILS[s.planId] || null;
                return {
                    id: s._id,
                    name: s.userId.name,
                    email: s.userId.email,
                    picture: s.userId.picture,
                    planName: planInfo?.name || "Unknown",
                    cycle: planInfo?.cycle === "yearly" ? "Yearly" : "Monthly",
                    status: s.status,
                    createdAt: s.createdAt,
                };
            });

        return res.json({
            summary: {
                totalUsers,
                premiumUsers,
                monthlyRevenue,
                yearlyRevenue,
            },
            activePlans,
            storageAlerts,
            recentSubscriptions,
        });
    } catch (err) {
        next(err);
    }
};