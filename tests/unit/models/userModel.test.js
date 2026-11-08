import { describe, it, expect } from "vitest";
import bcrypt from "bcrypt";
import User from "../../../models/userModel.js";
import { FREE_PLAN } from "../../../config/plans.js";
import { oid } from "../../helpers/fixtures.js";
import { errorFields } from "../../helpers/validation.js";

const validData = () => ({
  name: "Haadi",
  email: "haadi@example.com",
  rootDirId: oid(),
});

describe("User model", () => {
  it("accepts a minimal valid user (Google users have no password)", async () => {
    expect(await errorFields(new User(validData()))).toEqual([]);
  });

  it("applies safe defaults: free plan, one device, role User, not deleted", async () => {
    const user = new User(validData());
    expect(user.role).toBe("User");
    expect(user.isDeleted).toBe(false);
    expect(user.accessDevice).toBe(FREE_PLAN.deviceLimit);
    expect(user.maxStorageInBytes).toBe(FREE_PLAN.storage);
    expect(user.usedStorageInBytes).toBe(0);
    expect(user.reservedStorage).toBe(0);
  });

  it("lower-cases and trims the email", async () => {
    expect(new User({ ...validData(), email: "  Haadi@Example.COM " }).email).toBe("haadi@example.com");
  });

  it.each([
    ["name too short", { name: "ab" }, "name"],
    ["invalid email", { email: "nope" }, "email"],
    ["unknown role", { role: "Owner" }, "role"],
    ["password too short", { password: "abc" }, "password"],
  ])("rejects %s", async (_label, patch, field) => {
    expect(await errorFields(new User({ ...validData(), ...patch }))).toContain(field);
  });

  it.each(["name", "email", "rootDirId"])("requires %s", async (field) => {
    const data = validData();
    delete data[field];
    expect(await errorFields(new User(data))).toContain(field);
  });

  it("accepts every defined role", async () => {
    for (const role of ["SuperAdmin", "Admin", "Manager", "User"]) {
      expect(await errorFields(new User({ ...validData(), role }))).toEqual([]);
    }
  });

  it("rejects unknown fields instead of silently storing them (strict: 'throw')", async () => {
    expect(() => new User({ ...validData(), isAdmin: true })).toThrow();
  });

  it("enforces unique emails at the database level", async () => {
    expect(User.schema.path("email").options.unique).toBe(true);
  });

  describe("comparePassword", () => {
    it("verifies a bcrypt-hashed password", async () => {
      const user = new User({ ...validData(), password: await bcrypt.hash("secret-1", 4) });
      await expect(user.comparePassword("secret-1")).resolves.toBe(true);
      await expect(user.comparePassword("wrong")).resolves.toBe(false);
    });
  });
});
