import { describe, it, expect } from "vitest";
import {
  loginSchema,
  registerSchema,
  verifyOtpSchema,
  sendOtpSchema,
  changePasswordSchema,
  updateProfileSchema,
  roleSchema,
  userStatusSchema,
} from "../../../validators/authSchema.js";

const validRegister = {
  name: "Haadi",
  email: "USER@Example.com",
  password: "secret",
  otp: "1234",
};

describe("loginSchema", () => {
  it("accepts valid credentials and lower-cases the email", () => {
    const r = loginSchema.safeParse({ email: "USER@Example.com", password: "abcd" });
    expect(r.success).toBe(true);
    expect(r.data.email).toBe("user@example.com");
  });
  it("rejects an invalid email", () => {
    const r = loginSchema.safeParse({ email: "not-an-email", password: "abcd" });
    expect(r.success).toBe(false);
    expect(r.error.issues[0].message).toBe("Please enter a valid email.");
  });
  it("rejects passwords shorter than 4 characters", () => {
    expect(loginSchema.safeParse({ email: "a@b.co", password: "abc" }).success).toBe(false);
  });
  it("rejects missing fields", () => {
    expect(loginSchema.safeParse({}).success).toBe(false);
  });
});

describe("registerSchema", () => {
  it("accepts a valid registration", () => {
    const r = registerSchema.safeParse(validRegister);
    expect(r.success).toBe(true);
    expect(r.data.email).toBe("user@example.com");
  });
  it.each([
    ["short name", { name: "ab" }],
    ["long name", { name: "x".repeat(51) }],
    ["3 digit otp", { otp: "123" }],
    ["5 digit otp", { otp: "12345" }],
    ["non-numeric otp", { otp: "12ab" }],
    ["numeric (non-string) otp", { otp: 1234 }],
  ])("rejects %s", (_label, patch) => {
    expect(registerSchema.safeParse({ ...validRegister, ...patch }).success).toBe(false);
  });
});

describe("otp schemas", () => {
  it("sendOtpSchema only needs a valid email", () => {
    expect(sendOtpSchema.safeParse({ email: "a@b.co" }).success).toBe(true);
    expect(sendOtpSchema.safeParse({ email: "nope" }).success).toBe(false);
  });
  it("verifyOtpSchema needs email and a 4 digit otp", () => {
    expect(verifyOtpSchema.safeParse({ email: "a@b.co", otp: "0001" }).success).toBe(true);
    expect(verifyOtpSchema.safeParse({ email: "a@b.co", otp: "1" }).success).toBe(false);
    expect(verifyOtpSchema.safeParse({ email: "a@b.co" }).success).toBe(false);
  });
});

describe("changePasswordSchema", () => {
  it("accepts matching passwords (current password optional for Google users)", () => {
    expect(
      changePasswordSchema.safeParse({ newPassword: "abcd", confirmPassword: "abcd" }).success,
    ).toBe(true);
  });
  it("rejects mismatching confirmation with a message on confirmPassword", () => {
    const r = changePasswordSchema.safeParse({ newPassword: "abcd", confirmPassword: "abce" });
    expect(r.success).toBe(false);
    expect(r.error.issues[0].path).toEqual(["confirmPassword"]);
    expect(r.error.issues[0].message).toBe("Passwords do not match.");
  });
  it("rejects a too-short new password", () => {
    expect(
      changePasswordSchema.safeParse({ newPassword: "abc", confirmPassword: "abc" }).success,
    ).toBe(false);
  });
});

describe("updateProfileSchema", () => {
  it("allows an empty update and a valid name", () => {
    expect(updateProfileSchema.safeParse({}).success).toBe(true);
    expect(updateProfileSchema.safeParse({ name: "New Name" }).success).toBe(true);
  });
  it("rejects unknown keys (cannot sneak in role/email changes)", () => {
    expect(updateProfileSchema.safeParse({ name: "Valid", role: "Admin" }).success).toBe(false);
    expect(updateProfileSchema.safeParse({ email: "x@y.co" }).success).toBe(false);
  });
  it("enforces name length", () => {
    expect(updateProfileSchema.safeParse({ name: "ab" }).success).toBe(false);
    expect(updateProfileSchema.safeParse({ name: "x".repeat(51) }).success).toBe(false);
  });
});

describe("roleSchema", () => {
  it.each(["User", "Manager", "Admin"])("accepts %s", (role) => {
    expect(roleSchema.safeParse({ role }).success).toBe(true);
  });
  it("never lets SuperAdmin or unknown roles be assigned", () => {
    expect(roleSchema.safeParse({ role: "SuperAdmin" }).success).toBe(false);
    expect(roleSchema.safeParse({ role: "root" }).success).toBe(false);
    const r = roleSchema.safeParse({ role: "root" });
    expect(r.error.issues[0].message).toBe("Please enter valid role!");
  });
});

describe("userStatusSchema", () => {
  it.each([true, false])("accepts isDeleted: %s", (isDeleted) => {
    const r = userStatusSchema.safeParse({ isDeleted });
    expect(r.success).toBe(true);
    expect(r.data).toEqual({ isDeleted });
  });
  it.each([
    ["missing", {}],
    ["a string", { isDeleted: "true" }],
    ["a number", { isDeleted: 1 }],
    ["null", { isDeleted: null }],
  ])("rejects isDeleted when it is %s", (_label, body) => {
    const r = userStatusSchema.safeParse(body);
    expect(r.success).toBe(false);
    expect(r.error.issues[0].message).toBe("Please provide a valid status!");
  });
});
