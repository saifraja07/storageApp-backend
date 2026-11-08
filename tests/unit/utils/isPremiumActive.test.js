import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { isPremiumActive } from "../../../utils/isPremiumActive.js";

const NOW = new Date("2026-01-15T12:00:00Z");
const future = new Date(NOW.getTime() + 86_400_000).toISOString();
const past = new Date(NOW.getTime() - 86_400_000).toISOString();

describe("isPremiumActive", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });
  afterEach(() => vi.useRealTimers());

  it("is false without a subscription", () => {
    expect(isPremiumActive(null)).toBe(false);
    expect(isPremiumActive(undefined)).toBe(false);
  });

  it.each(["active", "authenticated", "pending", "paused", "cancelled"])(
    "keeps premium for a %s subscription until currentEnd",
    (status) => {
      expect(isPremiumActive({ status, currentEnd: future })).toBe(true);
      expect(isPremiumActive({ status, currentEnd: past })).toBe(false);
    },
  );

  it.each(["created", "halted", "completed", "expired", "unknown"])(
    "never grants premium for a %s subscription",
    (status) => {
      expect(isPremiumActive({ status, currentEnd: future })).toBe(false);
    },
  );

  it("is false when currentEnd is missing", () => {
    expect(isPremiumActive({ status: "active" })).toBe(false);
    expect(isPremiumActive({ status: "active", currentEnd: null })).toBe(false);
  });

  it("accepts Date objects as currentEnd", () => {
    expect(isPremiumActive({ status: "active", currentEnd: new Date(future) })).toBe(true);
  });
});
