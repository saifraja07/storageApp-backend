import { describe, it, expect, vi, beforeEach } from "vitest";

const ID_A = "507f1f77bcf86cd799439011";
const ID_B = "507f1f77bcf86cd799439012";

// The resolver parses its env var once at import time, so each test loads a
// fresh copy of the module.
async function load(ids) {
  vi.resetModules();
  if (ids !== undefined) vi.stubEnv("PERSONAL_STORAGE_USER_IDS", ids);
  return import("../../../services/storageResolver.js");
}

describe("isPersonalStorageUser", () => {
  beforeEach(() => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  it("is false for everyone when PERSONAL_STORAGE_USER_IDS is unset", async () => {
    const { isPersonalStorageUser } = await load();
    expect(isPersonalStorageUser(ID_A)).toBe(false);
  });

  it("is true only for the listed users", async () => {
    const { isPersonalStorageUser } = await load(`${ID_A}, ${ID_B}`);
    expect(isPersonalStorageUser(ID_A)).toBe(true);
    expect(isPersonalStorageUser(ID_B)).toBe(true);
    expect(isPersonalStorageUser("507f1f77bcf86cd799439099")).toBe(false);
  });

  it("matches case-insensitively and accepts ObjectId-like objects", async () => {
    const { isPersonalStorageUser } = await load(ID_A.toUpperCase());
    expect(isPersonalStorageUser(ID_A)).toBe(true);
    expect(isPersonalStorageUser({ toString: () => ID_A })).toBe(true);
  });

  it("is false for null / undefined user ids", async () => {
    const { isPersonalStorageUser } = await load(ID_A);
    expect(isPersonalStorageUser(null)).toBe(false);
    expect(isPersonalStorageUser(undefined)).toBe(false);
  });

  it("ignores blank entries in the list", async () => {
    const { isPersonalStorageUser } = await load(` , ${ID_A},, `);
    expect(isPersonalStorageUser(ID_A)).toBe(true);
    expect(isPersonalStorageUser("")).toBe(false);
  });

  it("warns (but does not throw) about malformed ids", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { isPersonalStorageUser } = await load("not-an-object-id");
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("not a 24-character hex"));
    expect(isPersonalStorageUser("anything")).toBe(false);
  });
});
