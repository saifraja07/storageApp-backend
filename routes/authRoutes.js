import express from "express";
import checkAuth from "../middleWares/authMiddleware.js";
import { login, loginWithGoogle, logout, logoutAll, register, sendOtp, verifyOtp } from "../controllers/authController.js";
import { rateLimiter, emailRateLimiter, throttle } from "../middleWares/limiterMiddleware.js";

const router = express.Router()

router.post("/register", rateLimiter(15 * 60 * 1000, 5, "auth-register"), register);

router.post("/login", rateLimiter(5 * 60 * 1000, 12, "auth-login"),
    emailRateLimiter(15 * 60 * 1000, 10, "auth-login-email"),
    throttle({ waitTime: 2000 }), login);

router.post("/google", rateLimiter(10 * 60 * 1000, 5, "auth-google"), throttle(), loginWithGoogle)

router.post("/otp/send", rateLimiter(15 * 60 * 1000, 5, "otp-send"),
    emailRateLimiter(15 * 60 * 1000, 5, "otp-send-email"), throttle({
    waitTime: 3000,
    delayAfter: 1,
    maxDelay: 15000,
}), sendOtp)

router.post("/otp/verify", rateLimiter(10 * 60 * 1000, 5, "otp-verify"),
    emailRateLimiter(15 * 60 * 1000, 10, "otp-verify-email"), throttle({
    delayAfter: 2,
    maxDelay: 5000
}), verifyOtp)

router.post("/logout", checkAuth, logout);

router.post("/logout-all", checkAuth, logoutAll);


export default router;
