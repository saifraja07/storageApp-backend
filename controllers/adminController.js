import User from "../models/userModel.js";
import File from "../models/fileModel.js";
import Directory from "../models/directoryModel.js";
import { ROLE_LEVELS } from "../utils/roles.js";
import { getTargetUser } from "../utils/getTargetUser.js";
import { canAssignRole } from "../utils/permissions.js";
import { cancelUserSubscriptions } from "../services/subscriptionCleanup.js";
import { roleSchema, userStatusSchema } from "../validators/authSchema.js";
import { deleteUserSessions, getActiveSessionUserIds } from "../utils/sessionUtils.js";
import { buildPagination, escapeRegex, parsePagination, parseSearch } from "../utils/pagination.js";
import { deleteR2Files, deleteProfilePicture, getProfilePictureKeyFromURL, isOwnedProfilePictureURL } from "../services/cloudflareR2Service.js";

export const getAllUsers = async (req, res) => {
    const role = req.query.role || undefined; // "" = no filter
    if (role && role !== "all" && !Object.hasOwn(ROLE_LEVELS, role)) {
        return res.status(400).json({ error: "Invalid role filter!" });
    };

    const { page, limit } = parsePagination(req.query);
    const search = parseSearch(req.query.search);

    // Filters are applied before pagination, and the count uses the same filter.
    const filter = {};
    if (role && role !== "all") filter.role = role;
    if (search) {
        const pattern = { $regex: escapeRegex(search), $options: "i" };
        filter.$or = [{ name: pattern }, { email: pattern }];
    }

    const totalItems = await User.countDocuments(filter);
    const pagination = buildPagination({ page, limit, totalItems });

    // Nothing matches: no page to fetch and no sessions to look up.
    if (totalItems === 0) {
        return res.status(200).json({ users: [], pagination });
    }

    const pageUsers = await User.find(filter)
        .select("name email role isDeleted picture maxStorageInBytes usedStorageInBytes")
        .sort({ createdAt: -1, _id: -1 })
        .skip((pagination.currentPage - 1) * limit)
        .limit(limit)
        .lean();

    // Only look up sessions for users on the current page.
    const loggedInUsers = await getActiveSessionUserIds(
        pageUsers.map(({ _id }) => _id)
    );

    const users = pageUsers.map(({ _id, name, email, role, isDeleted, picture, maxStorageInBytes, usedStorageInBytes, }) => ({
        id: _id,
        name,
        email,
        role,
        isDeleted,
        picture,
        maxStorageInBytes,
        usedStorageInBytes,
        isLoggedIn: loggedInUsers.has(_id.toString()),
    }));

    return res.status(200).json({
        users,
        pagination,
    });
};

export const getUserStats = async (req, res) => {
    const [[counts], loggedInUsers] = await Promise.all([
        User.aggregate([
            {
                $group: {
                    _id: null,
                    total: { $sum: 1 },
                    admins: { $sum: { $cond: [{ $eq: ["$role", "Admin"] }, 1, 0] } },
                    deleted: { $sum: { $cond: ["$isDeleted", 1, 0] } },
                },
            },
        ]),
        getActiveSessionUserIds(),
    ]);

    // "Online" = has an active session and is not deactivated.
    const active = loggedInUsers.size
        ? await User.countDocuments({ _id: { $in: [...loggedInUsers] }, isDeleted: { $ne: true } })
        : 0;

    return res.status(200).json({
        total: counts?.total ?? 0,
        active,
        admins: counts?.admins ?? 0,
        deleted: counts?.deleted ?? 0,
    });
};

export const revokeUserSessions = async (req, res) => {
    const target = await getTargetUser(req, res);

    if (!target) return;

    await deleteUserSessions(target._id);

    return res.json({
        message: "User logged out from all devices",
    });
};

export const updateUserStatus = async (req, res) => {
    const { success, data, error } =
        userStatusSchema.safeParse(req.body);

    if (!success) {
        return res.status(400).json({
            error: error.issues[0].message,
        });
    }

    return data.isDeleted
        ? deactivateUser(req, res)
        : reactivateUser(req, res);
};

const deactivateUser = async (req, res) => {
    const { userId } = req.params;

    if (req.user._id.toString() === userId) {
        return res.status(403).json({
            error: "Cannot deactivate yourself!",
        });
    }

    const target = await getTargetUser(req, res);

    if (!target) return;

    target.isDeleted = true;
    await target.save();

    await deleteUserSessions(userId);

    return res.json({
        message: "User deactivated successfully",
    });
};

const reactivateUser = async (req, res) => {
    const target = await getTargetUser(req, res);

    if (!target) return;

    target.isDeleted = false;
    await target.save();

    return res.json({
        message: "User recovered successfully",
    });
};

export const permanentlyDeleteUser = async (req, res) => {
    const { userId } = req.params;

    if (req.user._id.toString() === userId) {
        return res.status(403).json({
            error: "Cannot delete yourself!",
        });
    }

    const target = await getTargetUser(req, res);

    if (!target) return;

    // Never delete an account that is still being billed: stop its subscriptions
    // first, and keep the account if that can't be done.
    try {
        await cancelUserSubscriptions(target._id);
    } catch (err) {
        console.error(`[admin] could not cancel subscriptions of ${userId} before deletion:`, err);
        return res.status(502).json({
            error: "Couldn't cancel this user's subscription with Razorpay, so the account was NOT deleted. Try again, or cancel it from the Razorpay dashboard first.",
        });
    }

    const allFiles = await File.find({ userId })
        .select("_id extension")
        .lean();

    const keys = allFiles.map(({ _id, extension }) => ({
        Key: `${_id}${extension}`,
    }));

    if (keys.length) {
        await deleteR2Files(keys, target._id);
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

export const updateUserRole = async (req, res) => {
    const { userId } = req.params;

    if (req.user._id.toString() === userId) {
        return res.status(403).json({
            error: "Cannot change your own role!",
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
            error: "Cannot assign this role!",
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
        message: "Role assigned successfully",
    });
};
