import { describe, it, expect } from "vitest";
import { canManageUser, canAssignRole, isAdminOrHigher } from "../../../utils/permissions.js";
import { ROLE_LEVELS } from "../../../utils/roles.js";

describe("ROLE_LEVELS", () => {
  it("orders roles User < Manager < Admin < SuperAdmin", () => {
    expect(ROLE_LEVELS.User).toBeLessThan(ROLE_LEVELS.Manager);
    expect(ROLE_LEVELS.Manager).toBeLessThan(ROLE_LEVELS.Admin);
    expect(ROLE_LEVELS.Admin).toBeLessThan(ROLE_LEVELS.SuperAdmin);
  });
});

describe("canManageUser", () => {
  it("allows managing strictly lower roles", () => {
    expect(canManageUser("SuperAdmin", "Admin")).toBe(true);
    expect(canManageUser("Admin", "Manager")).toBe(true);
    expect(canManageUser("Manager", "User")).toBe(true);
  });
  it("denies managing the same or a higher role", () => {
    expect(canManageUser("Admin", "Admin")).toBe(false);
    expect(canManageUser("Manager", "Admin")).toBe(false);
    expect(canManageUser("User", "SuperAdmin")).toBe(false);
  });
  it("denies unknown roles", () => {
    expect(canManageUser("Hacker", "User")).toBe(false);
    expect(canManageUser("Admin", "Hacker")).toBe(false);
    expect(canManageUser(undefined, "User")).toBe(false);
  });
});

describe("canAssignRole", () => {
  it("only lets an actor assign roles below their own", () => {
    expect(canAssignRole("SuperAdmin", "Admin")).toBe(true);
    expect(canAssignRole("Admin", "Manager")).toBe(true);
    expect(canAssignRole("Admin", "Admin")).toBe(false);
    expect(canAssignRole("Manager", "Admin")).toBe(false);
  });
  it("never allows privilege escalation to SuperAdmin", () => {
    for (const role of Object.keys(ROLE_LEVELS)) {
      expect(canAssignRole(role, "SuperAdmin")).toBe(false);
    }
  });
});

describe("isAdminOrHigher", () => {
  it("is true for Admin and SuperAdmin only", () => {
    expect(isAdminOrHigher("SuperAdmin")).toBe(true);
    expect(isAdminOrHigher("Admin")).toBe(true);
    expect(isAdminOrHigher("Manager")).toBe(false);
    expect(isAdminOrHigher("User")).toBe(false);
    expect(isAdminOrHigher("nope")).toBe(false);
  });
});
