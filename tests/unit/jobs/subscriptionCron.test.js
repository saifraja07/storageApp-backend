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

    expect(SubscriptionMock.findByIdAndUpdate).toHaveBeenCalledWith(s._id, { status: "expired" });
    expect(downgradeStorage).toHaveBeenCalledWith(s.userId);
  });

  it("expires without downgrading a user who is already on the free tier", async () => {
    const s = sub();
    SubscriptionMock.find.mockReturnValue(query([s]));
    UserMock.findById.mockReturnValue(query({ maxStorageInBytes: FREE_PLAN.storage }));

    await runSubscriptionExpiryJob();

    expect(SubscriptionMock.findByIdAndUpdate).toHaveBeenCalledWith(s._id, { status: "expired" });
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
});
