import { vi } from "vitest";

// Stand-in for config/redis.js (which opens a real connection on import).
export const redisMock = {
  json: { get: vi.fn(), set: vi.fn() },
  ft: { search: vi.fn() },
  expire: vi.fn(),
  del: vi.fn(),
  on: vi.fn(),
  connect: vi.fn(),
};
