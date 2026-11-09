import express from "express";
import { requireRole } from "../middleWares/authMiddleware.js";
import { rateLimiter } from "../middleWares/limiterMiddleware.js";
import { getPlansDashboard, getStorageUsage, refreshStorageUsage } from "../controllers/adminDashboardController.js";
import { getAllUsers, permanentlyDeleteUser, revokeUserSessions, updateUserRole, updateUserStatus } from "../controllers/adminController.js";

const router = express.Router();

router.get("/users", requireRole("Manager"), getAllUsers);

router.get("/dashboard/plans", requireRole("Manager"), getPlansDashboard);

router.get("/dashboard/storage/usage", requireRole("Admin"), getStorageUsage);

router.post("/dashboard/storage/usage/refresh", requireRole("Admin"), rateLimiter(60 * 1000, 6), refreshStorageUsage);

router.post("/users/:userId/sessions/revoke", requireRole("Manager"), revokeUserSessions);

router.patch("/users/:userId/status", requireRole("Admin"), updateUserStatus);

router.delete("/users/:userId", requireRole("SuperAdmin"), permanentlyDeleteUser);

router.patch("/users/:userId/role", requireRole("Admin"), updateUserRole);

export default router;
