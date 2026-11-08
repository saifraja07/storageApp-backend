import { vi } from "vitest";

// config/redis.js connects to a real Redis server at import time, so it is
// replaced for the whole suite.
vi.mock("../../config/redis.js", async () => ({
  default: (await import("../helpers/redisMock.js")).redisMock,
}));
