import { describe, it, expect } from "vitest";
import { errorFields } from "../../helpers/validation.js";
import OTP from "../../../models/otpModel.js";
import WebhookEvent from "../../../models/webhookEventModel.js";

describe("OTP model", () => {
  it("requires email and otp, and stores the otp as a number", async () => {
    expect((await errorFields(new OTP({})))).toEqual(
      expect.arrayContaining(["email", "otp"]),
    );
    const doc = new OTP({ email: "a@b.co", otp: "4821" });
    expect(await errorFields(doc)).toEqual([]);
    expect(doc.otp).toBe(4821);
  });

  it("expires automatically after 10 minutes (matches the e-mail text)", async () => {
    expect(OTP.schema.path("createdAt").options.expires).toBe(600);
  });

  it("allows only one pending OTP per e-mail address", async () => {
    expect(OTP.schema.path("email").options.unique).toBe(true);
  });
});

describe("WebhookEvent model", () => {
  const valid = () => ({
    event: "subscription.activated",
    webhookKey: "subscription.activated:sub_1:1700000000",
    payload: { any: "thing" },
  });

  it("accepts a valid event log entry with sensible defaults", async () => {
    const doc = new WebhookEvent(valid());
    expect(await errorFields(doc)).toEqual([]);
    expect(doc.status).toBe("received");
    expect(doc.error).toBeNull();
  });

  it("is deduplicated by a unique webhookKey (webhook idempotency relies on this)", async () => {
    expect(WebhookEvent.schema.path("webhookKey").options.unique).toBe(true);
  });

  it("schedules deletion about 90 days after creation", async () => {
    const doc = new WebhookEvent(valid());
    const days = (doc.expireAt.getTime() - Date.now()) / 86_400_000;
    expect(days).toBeGreaterThan(89.9);
    expect(days).toBeLessThanOrEqual(90);
  });

  it("only allows known processing statuses", async () => {
    const errors = await errorFields(new WebhookEvent({ ...valid(), status: "weird" }));
    expect(errors).toContain("status");
  });

  it.each(["event", "webhookKey", "payload"])("requires %s", async (field) => {
    const data = valid();
    delete data[field];
    expect((await errorFields(new WebhookEvent(data)))).toContain(field);
  });
});
