import express from "express";
import checkAuth from "../middleWares/authMiddleware.js";
import { login, loginWithGoogle, logout, logoutAll, register, sendOtp, verifyOtp } from "../controllers/authController.js";
import { rateLimiter, throttle } from "../middleWares/limiterMiddleware.js";

const router = express.Router()

router.post("/register", rateLimiter(15 * 60 * 1000, 5), register);

router.post("/login", rateLimiter(5 * 60 * 1000, 12),
    throttle({ waitTime: 2000 }), login);

router.post("/google", rateLimiter(10 * 60 * 1000, 5), throttle(), loginWithGoogle)

router.post("/otp/send", rateLimiter(10 * 60 * 1000, 3), throttle({
    waitTime: 3000,
    delayAfter: 1,
    maxDelay: 15000,
}), sendOtp)

router.post("/otp/verify", rateLimiter(10 * 60 * 1000, 5), throttle({
    delayAfter: 2,
    maxDelay: 5000
}), verifyOtp)

router.post("/logout", checkAuth, logout);

router.post("/logout-all", checkAuth, logoutAll);


export default router;
