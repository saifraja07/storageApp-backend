import { PLAN_DETAILS } from "../config/plans.js";
import redisClient from "../config/redis.js";
import Directory from "../models/directoryModel.js";
import File from "../models/fileModel.js";
import Subscription from "../models/subscriptionModel.js";
import User from "../models/userModel.js";
import { deleteR2Files, deleteProfilePicture, getProfilePictureKeyFromURL, isOwnedProfilePictureURL } from "../services/cloudflareR2Service.js";
import { getTargetUser } from "../utils/getTargetUser.js";
import { isPremiumActive } from "../utils/isPremiumActive.js";
import { canAssignRole } from "../utils/permissions.js";
import { roleSchema } from "../validators/authSchema.js";
import { deleteUserSessions } from "../utils/sessionUtils.js";

const LIVE_SUBSCRIPTION_STATUSES = [
    "created",
    "authenticated",
    "active",
    "pending",
    "paused",
    "cancelled",
];

export const getAllUsers = async (req, res) => {
    const allUsers = await User.find()
        .select("name email role isDeleted picture maxStorageInBytes usedStorageInBytes")
        .lean();

    // all active redis sessions
    const allSessions = await redisClient.ft.search(
        "userIdIdx",
        "*",
        {
            RETURN: ["userId"],
        }
    );
    const loggedInUsers = new Set(
        allSessions.documents.map(
            (doc) => doc.value.userId.toString()
        )
    );

    const transformedUsers = allUsers.map(
        ({ _id, name, email, role, isDeleted, picture, maxStorageInBytes, usedStorageInBytes }) => ({
            id: _id,
            name,
            email,
            role,
            isDeleted,
            picture,
            maxStorageInBytes,
            usedStorageInBytes,
            isLoggedIn: loggedInUsers.has(_id.toString()),
        })
    );
    return res.status(200).json(transformedUsers);
};

export const logoutByAdmin = async (req, res) => {
    const target = await getTargetUser(req, res);

    if (!target) return;

    await deleteUserSessions(target._id);

    return res.json({
        message: "User logged out",
    });
};

export const softDelete = async (req, res) => {
    const { userId } = req.params;

    if (req.user._id.toString() === userId) {
        return res.status(403).json({
            error: "Cannot delete yourself",
        });
    }

    const target = await getTargetUser(req, res);

    if (!target) return;

    target.isDeleted = true;
    await target.save();

    await deleteUserSessions(userId);

    return res.json({
        message: "User deleted",
    });
};

export const hardDelete = async (req, res) => {
    const { userId } = req.params;

    if (req.user._id.toString() === userId) {
        return res.status(403).json({
            error: "Cannot delete yourself",
        });
    }

    const target = await getTargetUser(req, res);

    if (!target) return;

    const allFiles = await File.find({ userId })
        .select("_id extension")
        .lean();

    const keys = allFiles.map(({ _id, extension }) => ({
        Key: `${_id}${extension}`,
    }));

    if (keys.length) {
        await deleteR2Files(keys);
    }

    if (isOwnedProfilePictureURL(target.picture, userId)) {
        const key = getProfilePictureKeyFromURL(target.picture);
        await deleteProfilePicture({ key }).catch((err) => {
            console.error("Failed to delete profile image during admin hard-delete:", key, err);
        });
    }

    await Promise.all([
        File.deleteMany({ userId }),
        deleteUserSessions(userId),
        Directory.deleteMany({ userId }),
        target.deleteOne(),
    ]);

    return res.json({
        message: "User deleted successfully",
    });
};

export const recoverUserByAdmin = async (req, res) => {
    const target = await getTargetUser(req, res);

    if (!target) return;

    target.isDeleted = false;
    await target.save();

    return res.json({
        message: "User recovered successfully",
    });
};

export const updateUserRole = async (req, res) => {
    const { userId } = req.params;

    if (req.user._id.toString() === userId) {
        return res.status(403).json({
            error: "Cannot change your own role",
        });
    }

    const { success, data, error } =
        roleSchema.safeParse(req.body);

    if (!success) {
        return res.status(400).json({
            error: error.issues[0].message,
        });
    }

    const target = await getTargetUser(req, res);

    if (!target) return;

    if (
        !canAssignRole(
            req.user.role,
            data.role
        )
    ) {
        return res.status(403).json({
            error: "Cannot assign this role",
        });
    }

    if (target.role === data.role) {
        return res.status(400).json({
            error: "User already has this role",
        });
    }
    target.role = data.role;
    await target.save();

    return res.json({
        message: "Role updated",
    });
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

            User.find({ isDeleted: { $ne: true } })
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
            .slice(0, 5);

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