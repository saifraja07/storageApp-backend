import redisClient from "../config/redis.js";
import { createR2UsageSnapshotService } from "../services/r2UsageSnapshotService.js";

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
