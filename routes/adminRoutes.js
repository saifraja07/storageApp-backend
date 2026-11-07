import express from "express";
import checkAuth, { requireRole } from "../middleWares/authMiddleware.js";
import { rateLimiter } from "../middleWares/limiterMiddleware.js";
import { getStorageUsage, refreshStorageUsage } from "../controllers/adminStorageController.js";
import { getAllUsers, getPlansDashboard, hardDelete, logoutByAdmin, recoverUserByAdmin, softDelete, updateUserRole } from "../controllers/adminController.js";

const router = express.Router();

router.get("/users", checkAuth, requireRole("Manager"), getAllUsers);

router.get("/plans-overview", checkAuth, requireRole("Manager"), getPlansDashboard);

router.get("/storage/usage", checkAuth, requireRole("Admin"), getStorageUsage);

router.post("/storage/usage/refresh", checkAuth, requireRole("Admin"), rateLimiter(60 * 1000, 6), refreshStorageUsage);

router.post("/users/:userId/logout", checkAuth, requireRole("Manager"), logoutByAdmin);

router.patch("/users/:userId/soft", checkAuth, requireRole("Admin"), softDelete);

router.delete("/users/:userId/hard", checkAuth, requireRole("SuperAdmin"), hardDelete);

router.patch("/users/:userId/recover", checkAuth, requireRole("Admin"), recoverUserByAdmin);

router.patch("/users/:userId/role", checkAuth, requireRole("Admin"), updateUserRole);

export default router;
