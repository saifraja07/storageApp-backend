import { describe, it, expect, vi, beforeEach } from "vitest";
import { runSubscriptionExpiryJob } from "../../../jobs/subscriptionCron.js";
import { SubscriptionMock, UserMock } from "../../helpers/modelMocks.js";
import { query } from "../../helpers/query.js";
import { oid } from "../../helpers/fixtures.js";
import { FREE_PLAN } from "../../../config/plans.js";
import { downgradeStorage } from "../../../services/storageService.js";

vi.mock("../../../models/subscriptionModel.js", async () => ({
  default: (await import("../../helpers/modelMocks.js")).SubscriptionMock,
}));
vi.mock("../../../models/userModel.js", async () => ({
  default: (await import("../../helpers/modelMocks.js")).UserMock,
}));
vi.mock("../../../services/storageService.js", () => ({ downgradeStorage: vi.fn() }));

const sub = (overrides = {}) => ({
  _id: oid(),
  userId: oid(),
  subscriptionId: "sub_1",
  status: "cancelled",
  currentEnd: new Date("2020-01-01"),
  ...overrides,
});

beforeEach(() => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("runSubscriptionExpiryJob", () => {
  it("only selects non-active subscriptions whose paid period has ended", async () => {
    SubscriptionMock.find.mockReturnValue(query([]));
    await runSubscriptionExpiryJob();

    const filter = SubscriptionMock.find.mock.calls[0][0];
    expect(filter.currentEnd.$lt).toBeInstanceOf(Date);
    expect(filter.status.$in.sort()).toEqual(
      ["authenticated", "cancelled", "created", "paused", "pending"].sort(),
    );
    // an active (still-billing) or already-ended subscription must never be touched
    expect(filter.status.$in).not.toContain("active");
    expect(filter.status.$in).not.toContain("expired");
  });

  it("does nothing when nothing has expired", async () => {
    SubscriptionMock.find.mockReturnValue(query([]));
    await runSubscriptionExpiryJob();
    expect(UserMock.findById).not.toHaveBeenCalled();
    expect(downgradeStorage).not.toHaveBeenCalled();
  });

  it("marks the subscription expired and downgrades a paying user", async () => {
    const s = sub();
    SubscriptionMock.find.mockReturnValue(query([s]));
    UserMock.findById.mockReturnValue(query({ maxStorageInBytes: FREE_PLAN.storage * 200 }));

    await runSubscriptionExpiryJob();

    expect(SubscriptionMock.findByIdAndUpdate).toHaveBeenCalledWith(s._id, {
      status: "expired",
      endedAt: s.currentEnd,
    });
    expect(downgradeStorage).toHaveBeenCalledWith(s.userId);
  });

  it("expires without downgrading a user who is already on the free tier", async () => {
    const s = sub();
    SubscriptionMock.find.mockReturnValue(query([s]));
    UserMock.findById.mockReturnValue(query({ maxStorageInBytes: FREE_PLAN.storage }));

    await runSubscriptionExpiryJob();

    expect(SubscriptionMock.findByIdAndUpdate).toHaveBeenCalledWith(s._id, {
      status: "expired",
      endedAt: s.currentEnd,
    });
    expect(downgradeStorage).not.toHaveBeenCalled();
  });

  it("skips subscriptions whose user no longer exists", async () => {
    SubscriptionMock.find.mockReturnValue(query([sub()]));
    UserMock.findById.mockReturnValue(query(null));

    await runSubscriptionExpiryJob();

    expect(SubscriptionMock.findByIdAndUpdate).not.toHaveBeenCalled();
    expect(downgradeStorage).not.toHaveBeenCalled();
  });

  it("keeps processing the remaining subscriptions if one fails", async () => {
    const broken = sub({ subscriptionId: "sub_broken" });
    const healthy = sub({ subscriptionId: "sub_ok" });
    SubscriptionMock.find.mockReturnValue(query([broken, healthy]));
    UserMock.findById.mockReturnValue(query({ maxStorageInBytes: FREE_PLAN.storage * 200 }));
    downgradeStorage.mockRejectedValueOnce(new Error("boom")).mockResolvedValueOnce(undefined);

    await runSubscriptionExpiryJob();

    expect(downgradeStorage).toHaveBeenCalledTimes(2);
    expect(SubscriptionMock.findByIdAndUpdate).toHaveBeenCalledTimes(2);
  });

  it("keeps the cancellation history: it never touches cancelledAt when expiring", async () => {
    const s = sub({ cancelledAt: new Date("2019-12-01") });
    SubscriptionMock.find.mockReturnValue(query([s]));
    UserMock.findById.mockReturnValue(query({ maxStorageInBytes: FREE_PLAN.storage * 200 }));

    await runSubscriptionExpiryJob();

    const update = SubscriptionMock.findByIdAndUpdate.mock.calls[0][1];
    expect(update).not.toHaveProperty("cancelledAt");
    expect(update.endedAt).toEqual(s.currentEnd);
  });

  it("does NOT downgrade a user who has already bought a newer paid plan", async () => {
    const s = sub();
    SubscriptionMock.find.mockReturnValue(query([s]));
    UserMock.findById.mockReturnValue(query({ maxStorageInBytes: FREE_PLAN.storage * 200 }));
    SubscriptionMock.exists.mockResolvedValue({ _id: oid() });

    await runSubscriptionExpiryJob();

    // the old one is still marked expired…
    expect(SubscriptionMock.findByIdAndUpdate).toHaveBeenCalledWith(s._id, expect.objectContaining({ status: "expired" }));
    // …but the storage they just paid for is left alone
    expect(downgradeStorage).not.toHaveBeenCalled();

    const filter = SubscriptionMock.exists.mock.calls[0][0];
    expect(filter.userId).toBe(s.userId);
    expect(filter._id).toEqual({ $ne: s._id });
    expect(filter.currentEnd.$gt).toBeInstanceOf(Date);
    expect(filter.status.$in).not.toContain("expired");
  });
});
