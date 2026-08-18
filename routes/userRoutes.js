import express from "express";
import checkAuth from "../middleWares/authMiddleware.js";
import { bulkDeleteItems, changePassword, currentLoggedUser,  login, logout, logoutAll,  register, selfHardDelete, selfSoftDelete, updateProfile } from "../controllers/userController.js";
import { rateLimiter, throttle } from "../middleWares/limiterMiddleware.js";
import { profileUpload } from "../middleWares/profileUploadMiddleware.js";


const router = express.Router();

router.post("/user/register", rateLimiter(15 * 60 * 1000, 5), register);

router.post("/user/login", rateLimiter(5 * 60 * 1000, 12),
    throttle({ waitTime: 2000 }), login);

router.post("/user/logout", checkAuth, logout);

router.post("/user/logout-all", checkAuth, logoutAll);

router.get("/user", checkAuth, currentLoggedUser);

router.patch("/user/change-password", checkAuth, changePassword);

router.patch("/user/update-profile", checkAuth, rateLimiter(15 * 60 * 1000, 10),
    profileUpload, updateProfile);

router.patch("/user/soft-delete", checkAuth, selfSoftDelete);

router.delete("/user/hard-delete", checkAuth, selfHardDelete);

router.post("/user/bulk-delete", checkAuth, bulkDeleteItems);


export default router;
