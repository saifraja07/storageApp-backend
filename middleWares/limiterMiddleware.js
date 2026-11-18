import { rateLimit, ipKeyGenerator } from 'express-rate-limit';
import { RedisStore } from 'rate-limit-redis';
import redisClient from '../config/redis.js';

// A Redis that is down or reconnecting queues commands instead of failing them,
// which would hang the request. Give up after a moment so `passOnStoreError`
// can let the request through.
const STORE_TIMEOUT_MS = 1000;

const sendCommand = async (...args) => {
    let timer;
    const timeout = new Promise((_, reject) => {
        timer = setTimeout(
            () => reject(new Error("Rate limit store timed out")),
            STORE_TIMEOUT_MS
        );
    });
    try {
        return await Promise.race([redisClient.sendCommand(args), timeout]);
    } finally {
        clearTimeout(timer);
    }
};

// Counters live in Redis, so every Lambda instance (or PM2 worker) shares them and
// they survive restarts. `name` gives each limiter its own key prefix, otherwise
// two routes with the same window and limit would share one counter.
const buildLimiter = (name, windowMs, limit, extra = {}) => {
    if (!name) throw new Error("rate limiter needs a unique name");

    return rateLimit({
        windowMs,
        limit,
        message: {
            error: "Too many requests. Please try again in a few minutes."
        },
        standardHeaders: 'draft-8',
        legacyHeaders: false,
        // Names the policy in the RateLimit headers, so a route's IP and e-mail
        // limiters don't both show up as the same "5-in-15min".
        identifier: name,
        // If Redis is briefly unavailable, let the request through instead of
        // locking every user out.
        passOnStoreError: true,
        store: new RedisStore({
            sendCommand,
            prefix: `rl:${name}:`,
        }),
        ...extra,
    });
};

// Limits per client IP.
export const rateLimiter = (windowMs, limit, name) =>
    buildLimiter(name, windowMs, limit, { ipv6Subnet: 56 });

// Limits per e-mail address in the request body, so rotating IPs doesn't help
// someone hammering one account.
export const emailRateLimiter = (windowMs, limit, name) =>
    buildLimiter(name, windowMs, limit, {
        keyGenerator: (req) => {
            const email = req.body?.email;
            // Oversized values can't be a real address; don't build huge Redis keys.
            return typeof email === "string" && email.trim() && email.length <= 254
                ? `email:${email.trim().toLowerCase()}`
                : ipKeyGenerator(req.ip, 56);
        },
    });


export function throttle({
    waitTime = 1000,
    delayAfter = 3,
    maxDelay = 10000,
    cleanupAfter = 5 * 60 * 1000,
} = {}) {
    const throttleData = {};

    setInterval(() => {
        const now = Date.now();

        for (const ip in throttleData) {
            if (now - throttleData[ip].lastSeen > cleanupAfter) {
                delete throttleData[ip];
            }
        }
    }, 60000);

    return (req, res, next) => {
        const now = Date.now();
        const ip = req.ip;

        const data = throttleData[ip] || {
            hits: 0,
            previousDelay: 0,
            lastRequestTime: now - waitTime,
            lastSeen: now,
        };

        data.hits++;
        data.lastSeen = now;

        let delay = 0;

        if (data.hits > delayAfter) {
            const timePassed = now - data.lastRequestTime;

            delay = Math.min(
                maxDelay,
                Math.max(
                    0,
                    waitTime + data.previousDelay - timePassed
                )
            );
        }

        data.previousDelay = delay;
        data.lastRequestTime = now;

        throttleData[ip] = data;

        setTimeout(next, delay);
    };
}