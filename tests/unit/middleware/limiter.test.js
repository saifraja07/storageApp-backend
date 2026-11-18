import { describe, it, expect, vi, afterEach } from "vitest";
import express from "express";
import request from "supertest";
import { rateLimiter, emailRateLimiter, throttle } from "../../../middleWares/limiterMiddleware.js";
import { redisMock } from "../../helpers/redisMock.js";

// The real store talks to Redis; swap in an in-memory one that honours the
// same Store interface so the limiter logic itself is what gets tested.
const stores = vi.hoisted(() => []);

vi.mock("rate-limit-redis", () => ({
  RedisStore: class {
    constructor({ prefix, sendCommand }) {
      this.prefix = prefix;
      this.sendCommand = sendCommand;
      this.hits = new Map();
      stores.push(this);
    }
    init(options) {
      this.windowMs = options.windowMs;
    }
    async increment(key) {
      const totalHits = (this.hits.get(key) ?? 0) + 1;
      this.hits.set(key, totalHits);
      return { totalHits, resetTime: new Date(Date.now() + this.windowMs) };
    }
    async decrement(key) {
      this.hits.set(key, (this.hits.get(key) ?? 1) - 1);
    }
    async resetKey(key) {
      this.hits.delete(key);
    }
  },
}));

describe("rateLimiter", () => {
  let id = 0;
  const buildApp = (limit) => {
    const app = express();
    app.use(rateLimiter(60_000, limit, `test-${id++}`));
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

describe("store Redis calls", () => {
  const storeFor = (name) => {
    rateLimiter(60_000, 1, name);
    return stores.at(-1);
  };

  afterEach(() => {
    vi.useRealTimers();
    delete redisMock.sendCommand;
  });

  it("passes the command to the Redis client and returns its reply", async () => {
    redisMock.sendCommand = vi.fn().mockResolvedValue("OK");
    const store = storeFor("cmd-ok");

    await expect(store.sendCommand("EVALSHA", "sha", "1", "key")).resolves.toBe("OK");
    expect(redisMock.sendCommand).toHaveBeenCalledWith(["EVALSHA", "sha", "1", "key"]);
  });

  it("gives up after a second when Redis never answers, so requests aren't hung", async () => {
    vi.useFakeTimers();
    redisMock.sendCommand = vi.fn(() => new Promise(() => {}));
    const store = storeFor("cmd-hang");

    const result = expect(store.sendCommand("EVALSHA", "sha")).rejects.toThrow(/timed out/);
    await vi.advanceTimersByTimeAsync(1000);
    await result;
  });
});

describe("rateLimiter name", () => {
  it("refuses to be created without a unique name", () => {
    expect(() => rateLimiter(60_000, 1)).toThrow(/name/);
    expect(() => emailRateLimiter(60_000, 1)).toThrow(/name/);
  });
});

describe("emailRateLimiter", () => {
  const buildApp = (limit) => {
    const app = express();
    app.use(express.json());
    app.use(emailRateLimiter(60_000, limit, "test-email"));
    app.post("/", (_req, res) => res.json({ ok: true }));
    return app;
  };
  const send = (app, email) => request(app).post("/").send({ email });

  it("counts per e-mail address, case-insensitively", async () => {
    const app = buildApp(2);
    await send(app, "a@b.co").expect(200);
    await send(app, "A@B.co ").expect(200);
    await send(app, "a@b.co").expect(429);
  });

  it("does not block a different e-mail from the same IP", async () => {
    const app = buildApp(1);
    await send(app, "a@b.co").expect(200);
    await send(app, "a@b.co").expect(429);
    await send(app, "other@b.co").expect(200);
  });

  it("falls back to the IP for an oversized e-mail value", async () => {
    const app = buildApp(1);
    await send(app, "a".repeat(300) + "@b.co").expect(200);
    await send(app, "b".repeat(300) + "@b.co").expect(429);
  });

  it("falls back to the IP when there is no e-mail in the body", async () => {
    const app = buildApp(1);
    await request(app).post("/").send({}).expect(200);
    await request(app).post("/").send({}).expect(429);
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
