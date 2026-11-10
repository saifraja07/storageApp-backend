import { describe, it, expect } from "vitest";
import { FREE_PLAN, PLAN_CONFIG, PLAN_DETAILS } from "../../../config/plans.js";
import { PLAN_IDS } from "../../../validators/subscriptionSchema.js";

// webhookController throws at startup when these drift apart, which would
// take the whole API down on deploy — so check it here first.
describe("plan configuration", () => {
  it("has a PLAN_CONFIG entry for every plan the API accepts", () => {
    for (const id of PLAN_IDS) {
      expect(PLAN_CONFIG, `missing PLAN_CONFIG for ${id}`).toHaveProperty(id);
    }
  });

  it("has PLAN_DETAILS for every plan the API accepts", () => {
    for (const id of PLAN_IDS) {
      expect(PLAN_DETAILS, `missing PLAN_DETAILS for ${id}`).toHaveProperty(id);
    }
  });

  it("does not define plans the API would reject", () => {
    expect(Object.keys(PLAN_CONFIG).sort()).toEqual([...PLAN_IDS].sort());
    expect(Object.keys(PLAN_DETAILS).sort()).toEqual([...PLAN_IDS].sort());
  });

  it("gives every paid plan more storage and devices than the free plan", () => {
    for (const plan of Object.values(PLAN_CONFIG)) {
      expect(plan.storage).toBeGreaterThan(FREE_PLAN.storage);
      expect(plan.deviceLimit).toBeGreaterThan(FREE_PLAN.deviceLimit);
    }
  });

  it("uses positive prices and valid billing cycles", () => {
    for (const details of Object.values(PLAN_DETAILS)) {
      expect(details.price).toBeGreaterThan(0);
      expect(["monthly", "yearly"]).toContain(details.cycle);
    }
  });

  it("charges more for a yearly plan than its monthly equivalent", () => {
    const entries = Object.values(PLAN_DETAILS);
    for (const yearly of entries.filter((p) => p.cycle === "yearly")) {
      const monthly = entries.find((p) => p.cycle === "monthly" && p.name === yearly.name);
      expect(monthly, `no monthly plan named ${yearly.name}`).toBeDefined();
      expect(yearly.price).toBeGreaterThan(monthly.price);
    }
  });

  it("grants storage and devices by tier (Pro / Premium), not by billing cycle", () => {
    const byName = {};
    for (const [id, d] of Object.entries(PLAN_DETAILS)) (byName[d.name] ??= []).push(PLAN_CONFIG[id]);

    expect(byName.Pro).toHaveLength(2);
    expect(byName.Premium).toHaveLength(2);
    expect(byName.Pro[0]).toEqual(byName.Pro[1]);
    expect(byName.Premium[0]).toEqual(byName.Premium[1]);
    expect(byName.Pro[0]).toEqual({ storage: 100 * 1024 ** 3, deviceLimit: 3 });
    expect(byName.Premium[0]).toEqual({ storage: 500 * 1024 ** 3, deviceLimit: 4 });
  });

  it("defines a 500 MB, single-device free plan", () => {
    expect(FREE_PLAN).toEqual({ storage: 0.5 * 1024 ** 3, deviceLimit: 1 });
  });
});
