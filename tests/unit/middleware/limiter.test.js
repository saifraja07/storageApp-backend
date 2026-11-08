import { describe, it, expect, vi, afterEach } from "vitest";
import express from "express";
import request from "supertest";
import { rateLimiter, throttle } from "../../../middleWares/limiterMiddleware.js";

describe("rateLimiter", () => {
  const buildApp = (limit) => {
    const app = express();
    app.use(rateLimiter(60_000, limit));
    app.get("/", (_req, res) => res.json({ ok: true }));
    return app;
  };

  it("allows requests up to the limit then answers 429", async () => {
    const app = buildApp(2);
    await request(app).get("/").expect(200);
    await request(app).get("/").expect(200);
    const blocked = await request(app).get("/").expect(429);
    expect(blocked.body).toEqual({
      error: "Too many requests. Please try again in a few minutes.",
    });
  });

  it("sends standard rate-limit headers and no legacy X-RateLimit headers", async () => {
    const res = await request(buildApp(5)).get("/");
    expect(res.headers).toHaveProperty("ratelimit");
    expect(res.headers).not.toHaveProperty("x-ratelimit-limit");
  });

  it("keeps separate counters per limiter instance", async () => {
    const a = buildApp(1);
    const b = buildApp(1);
    await request(a).get("/").expect(200);
    await request(a).get("/").expect(429);
    await request(b).get("/").expect(200);
  });
});

describe("throttle", () => {
  afterEach(() => vi.useRealTimers());

  function hit(mw, ip = "1.1.1.1") {
    const next = vi.fn();
    mw({ ip }, {}, next);
    return next;
  }

  it("does not delay the first requests (up to delayAfter)", () => {
    vi.useFakeTimers();
    const mw = throttle({ waitTime: 1000, delayAfter: 2, maxDelay: 5000 });
    const first = hit(mw);
    const second = hit(mw);
    vi.advanceTimersByTime(0);
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledTimes(1);
  });

  it("delays requests beyond delayAfter", () => {
    vi.useFakeTimers();
    const mw = throttle({ waitTime: 1000, delayAfter: 1, maxDelay: 5000 });
    hit(mw);
    const delayed = hit(mw);
    vi.advanceTimersByTime(500);
    expect(delayed).not.toHaveBeenCalled();
    vi.advanceTimersByTime(600);
    expect(delayed).toHaveBeenCalledTimes(1);
  });

  it("never delays longer than maxDelay", () => {
    vi.useFakeTimers();
    const mw = throttle({ waitTime: 1000, delayAfter: 0, maxDelay: 1500 });
    const calls = Array.from({ length: 6 }, () => hit(mw));
    vi.advanceTimersByTime(1500);
    calls.forEach((c) => expect(c).toHaveBeenCalledTimes(1));
  });

  it("tracks each IP separately", () => {
    vi.useFakeTimers();
    const mw = throttle({ waitTime: 1000, delayAfter: 1, maxDelay: 5000 });
    hit(mw, "1.1.1.1");
    const slow = hit(mw, "1.1.1.1");
    const other = hit(mw, "2.2.2.2");
    vi.advanceTimersByTime(0);
    expect(other).toHaveBeenCalledTimes(1);
    expect(slow).not.toHaveBeenCalled();
  });
});
