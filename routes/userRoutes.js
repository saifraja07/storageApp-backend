import express from "express";
import { changePassword } from "../controllers/authController.js";
import { bulkDeleteItems, currentLoggedUser, selfHardDelete, selfSoftDelete, updateProfile } from "../controllers/userController.js";
import { rateLimiter } from "../middleWares/limiterMiddleware.js";
import { profileUpload } from "../middleWares/profileUploadMiddleware.js";


const router = express.Router();

router.get("/me", currentLoggedUser);

router.patch("/me/profile", rateLimiter(15 * 60 * 1000, 10),
    profileUpload, updateProfile);

router.patch("/me/password", changePassword);

router.patch("/me/deactivation", selfSoftDelete);

router.delete("/me", selfHardDelete);

router.post("/me/bulk-delete", bulkDeleteItems);


export default router;
