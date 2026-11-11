import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import { loadApp, request } from "../helpers/app.js";
import { redisMock } from "../helpers/redisMock.js";
import { UserMock, FileMock, DirectoryMock, SubscriptionMock, PaymentMock } from "../helpers/modelMocks.js";
import { istMonthKey } from "../../services/revenueService.js";
import { query } from "../helpers/query.js";
import { makeUser, oid, signedSidCookie } from "../helpers/fixtures.js";
import { deleteR2Files } from "../../services/cloudflareR2Service.js";

// Razorpay is only reached when a deleted account still has a live subscription.
const { rzp } = vi.hoisted(() => ({
  rzp: { subscriptions: { cancel: vi.fn(), fetch: vi.fn() } },
}));
vi.mock("razorpay", () => ({
  default: class {
    constructor() {
      return rzp;
    }
  },
}));

// The Cloudflare usage snapshot is fetched over the network; the controller's
// own behaviour (auth, caching headers, force flag) is what these tests cover.
const { getUsage } = vi.hoisted(() => ({ getUsage: vi.fn() }));
vi.mock("../../services/r2UsageSnapshotService.js", () => ({
  createR2UsageSnapshotService: () => ({ getUsage }),
}));

let app;
beforeAll(async () => {
  app = await loadApp();
});

beforeEach(() => {
  redisMock.ft.search.mockResolvedValue({ total: 0, documents: [] });
});

/**
 * Logs in as `role`. `checkAuth` runs once per admin request (server.js mounts
 * /admin behind it), so the first User.findById call is authentication; the
 * second (if `target` is given) is the controller's lookup of the user being
 * managed.
 */
function actAs(role, target) {
  const actor = makeUser({ role });
  redisMock.json.get.mockResolvedValue({ userId: actor._id });
  UserMock.findById.mockReturnValueOnce(query(actor));
  if (target !== undefined) UserMock.findById.mockResolvedValueOnce(target);
  return { actor, cookie: signedSidCookie() };
}

const target = (role = "User", extra = {}) => ({
  ...makeUser({ role }),
  save: vi.fn().mockResolvedValue(undefined),
  deleteOne: vi.fn().mockResolvedValue(undefined),
  ...extra,
});

describe("role requirements", () => {
  const matrix = [
    // [method, path, minimum role]
    ["get", "/admin/users", "Manager"],
    ["get", "/admin/dashboard/plans", "Manager"],
    ["get", "/admin/dashboard/storage/usage", "Admin"],
    ["post", "/admin/dashboard/storage/usage/refresh", "Admin"],
    ["post", "/admin/users/507f1f77bcf86cd799439011/sessions/revoke", "Manager"],
    ["patch", "/admin/users/507f1f77bcf86cd799439011/status", "Admin"],
    ["delete", "/admin/users/507f1f77bcf86cd799439011", "SuperAdmin"],
    ["patch", "/admin/users/507f1f77bcf86cd799439011/role", "Admin"],
  ];
  const order = ["User", "Manager", "Admin", "SuperAdmin"];

  it.each(matrix)("%s %s is closed to roles below %s", async (method, path, minRole) => {
    const lowerRoles = order.slice(0, order.indexOf(minRole));
    for (const role of lowerRoles) {
      const { cookie } = actAs(role);
      const res = await request(app)[method](path).set("Cookie", cookie).send({});
      expect(res.status, `${role} on ${method} ${path}`).toBe(403);
      expect(res.body).toEqual({ error: "Access denied!" });
    }
  });
});

describe("GET /admin/users", () => {
  it("lists users with their online status, for managers", async () => {
    const { cookie } = actAs("Manager");
    const online = makeUser({ name: "Online" });
    const offline = makeUser({ name: "Offline" });
    UserMock.find.mockReturnValue(query([online, offline]));
    redisMock.ft.search.mockResolvedValue({
      total: 1,
      documents: [{ id: "session:a", value: { userId: String(online._id) } }],
    });

    const res = await request(app).get("/admin/users").set("Cookie", cookie).expect(200);

    const byName = Object.fromEntries(res.body.map((u) => [u.name, u]));
    expect(byName.Online.isLoggedIn).toBe(true);
    expect(byName.Offline.isLoggedIn).toBe(false);
    expect(res.body[0]).not.toHaveProperty("password");
  });
});

describe("POST /admin/users/:userId/sessions/revoke", () => {
  it("ends the target's sessions", async () => {
    const t = target("User");
    const { cookie } = actAs("Manager", t);
    redisMock.ft.search.mockResolvedValue({ total: 1, documents: [{ id: "session:x" }] });
    const res = await request(app).post(`/admin/users/${t._id}/sessions/revoke`).set("Cookie", cookie).expect(200);
    expect(res.body.message).toBe("User logged out from all devices");
    expect(redisMock.del).toHaveBeenCalledWith("session:x");
  });

  it("returns 404 for an unknown user", async () => {
    const { cookie } = actAs("Manager", null);
    await request(app).post(`/admin/users/${oid()}/sessions/revoke`).set("Cookie", cookie).expect(404);
  });

  it("cannot act on someone with an equal or higher role", async () => {
    const { cookie } = actAs("Manager", target("Admin"));
    await request(app).post(`/admin/users/${oid()}/sessions/revoke`).set("Cookie", cookie).expect(403);
    expect(redisMock.del).not.toHaveBeenCalled();
  });
});

describe("PATCH /admin/users/:userId/status", () => {
  const setStatus = (cookie, id, body) =>
    request(app).patch(`/admin/users/${id}/status`).set("Cookie", cookie).send(body);

  describe("{ isDeleted: true } (deactivate)", () => {
    it("disables a lower-ranked user and ends their sessions", async () => {
      const t = target("Manager");
      const { cookie } = actAs("Admin", t);
      redisMock.ft.search.mockResolvedValue({ total: 1, documents: [{ id: "session:x" }] });
      const res = await setStatus(cookie, t._id, { isDeleted: true }).expect(200);
      expect(res.body.message).toBe("User deactivated successfully");
      expect(t.isDeleted).toBe(true);
      expect(t.save).toHaveBeenCalledTimes(1);
      expect(redisMock.del).toHaveBeenCalledWith("session:x");
    });

    it("refuses to let admins disable themselves", async () => {
      const { actor, cookie } = actAs("Admin");
      const res = await setStatus(cookie, actor._id, { isDeleted: true }).expect(403);
      expect(res.body.error).toBe("Cannot deactivate yourself!");
    });

    it("refuses to disable another admin", async () => {
      const t = target("Admin");
      const { cookie } = actAs("Admin", t);
      await setStatus(cookie, t._id, { isDeleted: true }).expect(403);
      expect(t.save).not.toHaveBeenCalled();
    });

    it("returns 404 for an unknown user", async () => {
      const { cookie } = actAs("Admin", null);
      await setStatus(cookie, oid(), { isDeleted: true }).expect(404);
    });
  });

  describe("{ isDeleted: false } (reactivate)", () => {
    it("re-enables a disabled user", async () => {
      const t = target("User", { isDeleted: true });
      const { cookie } = actAs("Admin", t);
      const res = await setStatus(cookie, t._id, { isDeleted: false }).expect(200);
      expect(res.body.message).toBe("User recovered successfully");
      expect(t.isDeleted).toBe(false);
      expect(t.save).toHaveBeenCalledTimes(1);
    });

    it("does not touch sessions", async () => {
      const t = target("User", { isDeleted: true });
      const { cookie } = actAs("Admin", t);
      await setStatus(cookie, t._id, { isDeleted: false }).expect(200);
      expect(redisMock.del).not.toHaveBeenCalled();
    });

    it("cannot act on someone with an equal or higher role", async () => {
      const t = target("Admin", { isDeleted: true });
      const { cookie } = actAs("Admin", t);
      await setStatus(cookie, t._id, { isDeleted: false }).expect(403);
      expect(t.save).not.toHaveBeenCalled();
    });
  });

  it.each([
    ["an empty body", {}],
    ["a non-boolean value", { isDeleted: "true" }],
    ["null", { isDeleted: null }],
  ])("validates the requested state (%s) before touching the user", async (_label, body) => {
    const { cookie } = actAs("Admin");
    const res = await setStatus(cookie, oid(), body).expect(400);
    expect(res.body.error).toBe("Please provide a valid status!");
    expect(UserMock.findById).toHaveBeenCalledTimes(1); // authentication only
  });
});

describe("DELETE /admin/users/:userId", () => {
  it("lets a SuperAdmin permanently delete a user, their files and sessions", async () => {
    const t = target("Admin");
    const { cookie } = actAs("SuperAdmin", t);
    const fileId = oid();
    FileMock.find.mockReturnValue(query([{ _id: fileId, extension: ".pdf" }]));
    SubscriptionMock.find.mockReturnValue(query([]));
    redisMock.ft.search.mockResolvedValue({ total: 1, documents: [{ id: "session:x" }] });

    await request(app).delete(`/admin/users/${t._id}`).set("Cookie", cookie).expect(200);

    expect(deleteR2Files).toHaveBeenCalledWith([{ Key: `${fileId}.pdf` }], t._id);
    expect(FileMock.deleteMany).toHaveBeenCalled();
    expect(DirectoryMock.deleteMany).toHaveBeenCalled();
    expect(t.deleteOne).toHaveBeenCalledTimes(1);
    expect(redisMock.del).toHaveBeenCalledWith("session:x");
  });

  describe("a user with a live subscription", () => {
    const withLiveSub = () => {
      const t = target("User");
      const { cookie } = actAs("SuperAdmin", t);
      const subDoc = { _id: oid(), subscriptionId: "sub_live" };
      FileMock.find.mockReturnValue(query([]));
      SubscriptionMock.find.mockReturnValue(query([subDoc]));
      return { t, cookie, subDoc };
    };

    it("stops the billing on Razorpay BEFORE deleting the account", async () => {
      const { t, cookie, subDoc } = withLiveSub();
      rzp.subscriptions.cancel.mockResolvedValue({});

      await request(app).delete(`/admin/users/${t._id}`).set("Cookie", cookie).expect(200);

      expect(rzp.subscriptions.cancel).toHaveBeenCalledWith("sub_live"); // immediate, no cycle to honour
      expect(SubscriptionMock.updateMany).toHaveBeenCalledWith(
        { _id: { $in: [subDoc._id] } },
        expect.objectContaining({ status: "expired", cancelledAt: expect.any(Date), endedAt: expect.any(Date) }),
      );
      expect(t.deleteOne).toHaveBeenCalledTimes(1);
    });

    it("keeps the account (nothing deleted) if Razorpay refuses to cancel", async () => {
      const { t, cookie } = withLiveSub();
      vi.spyOn(console, "error").mockImplementation(() => {});
      rzp.subscriptions.cancel.mockRejectedValue(new Error("rzp down"));
      rzp.subscriptions.fetch.mockResolvedValue({ status: "active" });

      const res = await request(app).delete(`/admin/users/${t._id}`).set("Cookie", cookie).expect(502);

      expect(res.body.error).toMatch(/NOT deleted/);
      expect(t.deleteOne).not.toHaveBeenCalled();
      expect(FileMock.deleteMany).not.toHaveBeenCalled();
      expect(deleteR2Files).not.toHaveBeenCalled();
    });

    it("carries on when the subscription was already cancelled on Razorpay's side", async () => {
      const { t, cookie } = withLiveSub();
      rzp.subscriptions.cancel.mockRejectedValue(new Error("already cancelled"));
      rzp.subscriptions.fetch.mockResolvedValue({ status: "cancelled" });

      await request(app).delete(`/admin/users/${t._id}`).set("Cookie", cookie).expect(200);
      expect(t.deleteOne).toHaveBeenCalledTimes(1);
    });
  });

  it("refuses to delete yourself", async () => {
    const { actor, cookie } = actAs("SuperAdmin");
    const res = await request(app).delete(`/admin/users/${actor._id}`).set("Cookie", cookie).expect(403);
    expect(res.body.error).toBe("Cannot delete yourself!");
  });
});

describe("PATCH /admin/users/:userId/role", () => {
  const setRole = (cookie, id, role) =>
    request(app).patch(`/admin/users/${id}/role`).set("Cookie", cookie).send({ role });

  it("validates the role value", async () => {
    const { cookie } = actAs("SuperAdmin");
    const res = await setRole(cookie, oid(), "SuperAdmin").expect(400);
    expect(res.body.error).toBe("Please enter valid role!");
  });

  it("refuses to change your own role", async () => {
    const { actor, cookie } = actAs("Admin");
    const res = await setRole(cookie, actor._id, "Manager").expect(403);
    expect(res.body.error).toBe("Cannot change your own role!");
  });

  it("lets an Admin promote a user to Manager", async () => {
    const t = target("User");
    const { cookie } = actAs("Admin", t);
    const res = await setRole(cookie, t._id, "Manager").expect(200);
    expect(res.body.message).toBe("Role assigned successfully");
    expect(t.role).toBe("Manager");
    expect(t.save).toHaveBeenCalledTimes(1);
  });

  it("prevents privilege escalation: an Admin cannot create another Admin", async () => {
    const t = target("Manager");
    const { cookie } = actAs("Admin", t);
    const res = await setRole(cookie, t._id, "Admin").expect(403);
    expect(res.body.error).toBe("Cannot assign this role!");
    expect(t.save).not.toHaveBeenCalled();
  });

  it("rejects a no-op role change", async () => {
    const t = target("User");
    const { cookie } = actAs("Admin", t);
    const res = await setRole(cookie, t._id, "User").expect(400);
    expect(res.body.error).toBe("User already has this role");
  });
});

describe("GET /admin/dashboard/plans", () => {
  const DAY = 24 * 60 * 60 * 1000;
  const thisMonth = () => istMonthKey(new Date());

  // Wires every query the dashboard makes.
  function stubDashboard({ owner, sub, payments = [], ledgerRows = [], recentSubs, alerts }) {
    UserMock.countDocuments.mockResolvedValue(7);
    SubscriptionMock.aggregate.mockResolvedValue(sub ? [sub] : []);
    SubscriptionMock.find.mockReturnValue(
      query(
        recentSubs ??
          (sub ? [{ ...sub, userId: { name: owner.name, email: owner.email, picture: owner.picture } }] : []),
      ),
    );
    UserMock.aggregate.mockResolvedValue(alerts ?? []);
    UserMock.find.mockReturnValue(query(owner ? [owner] : []));
    PaymentMock.aggregate.mockResolvedValue(ledgerRows);
    PaymentMock.find.mockReturnValue(query(payments));
  }

  it("summarises users, recurring + received revenue, storage alerts and recent activity", async () => {
    const { cookie } = actAs("Manager");
    const owner = makeUser({ name: "Pat", email: "pat@example.com", maxStorageInBytes: 1000, usedStorageInBytes: 900 });
    const sub = {
      _id: oid(),
      userId: owner._id,
      planId: "plan_T7QOKw1SWn3YA9", // Pro, monthly (₹169)
      status: "active",
      currentEnd: new Date(Date.now() + 10 * DAY),
      createdAt: new Date(),
    };
    stubDashboard({
      owner,
      sub,
      alerts: [{ ...owner, percentUsed: 90 }],
      ledgerRows: [{ _id: thisMonth(), grossPaise: 16900, refundedPaise: 0, payments: 1 }],
      payments: [
        {
          _id: oid(), paymentId: "pay_1", userId: { name: "Pat", email: "pat@example.com" },
          planId: sub.planId, planName: "Pro", cycle: "monthly",
          amountPaise: 16900, refundedPaise: 0, status: "captured", method: "upi", paidAt: new Date(),
        },
      ],
    });

    const res = await request(app).get("/admin/dashboard/plans").set("Cookie", cookie).expect(200);

    expect(res.body.summary).toEqual({
      totalUsers: 7,
      premiumUsers: 1,
      payingSubscribers: 1,
      cancellingUsers: 0,
      pastDueUsers: 0,
      expiringSoon: 0,
      lifetimeRevenue: 169,
      revenueThisMonth: 169,
      revenueLastMonth: 0,
      revenueThisYear: 169,
      refundedTotal: 0,
      totalPayments: 1,
      mrr: 169,
    });
    expect(res.body.activePlans).toHaveLength(1);
    expect(res.body.activePlans[0]).toMatchObject({
      name: "Pat", planName: "Pro", cycle: "Monthly", status: "active",
      displayStatus: "active", displayLabel: "Active", renews: true,
    });
    expect(res.body.storageAlerts[0]).toMatchObject({ email: "pat@example.com", percentUsed: 90 });
    expect(res.body.recentSubscriptions[0]).toMatchObject({ name: "Pat", planName: "Pro", displayStatus: "active" });
  });

  it("a CANCELLED subscription keeps its payment in revenue and shows as 'cancelling' until it ends", async () => {
    const { cookie } = actAs("Manager");
    const owner = makeUser({ name: "Sam" });
    const sub = {
      _id: oid(),
      userId: owner._id,
      planId: "plan_T7QPutFKX9ueS5", // Pro, yearly (₹1599)
      status: "cancelled",
      cancelledAt: new Date(),
      currentEnd: new Date(Date.now() + 200 * DAY),
      createdAt: new Date(),
    };
    stubDashboard({
      owner,
      sub,
      ledgerRows: [{ _id: thisMonth(), grossPaise: 159900, refundedPaise: 0, payments: 1 }],
    });

    const res = await request(app).get("/admin/dashboard/plans").set("Cookie", cookie).expect(200);

    // the money was received → still counted…
    expect(res.body.summary.lifetimeRevenue).toBe(1599);
    expect(res.body.summary.revenueThisMonth).toBe(1599);
    // …they keep paid access, but are not part of recurring revenue (they won't renew)
    expect(res.body.summary).toMatchObject({ premiumUsers: 1, cancellingUsers: 1, payingSubscribers: 0, mrr: 0, expiringSoon: 0 });
    expect(res.body.activePlans[0]).toMatchObject({ displayStatus: "cancelling", renews: false });
  });

  it("an ENDED subscription no longer lists as a plan, but its payments still count", async () => {
    const { cookie } = actAs("Manager");
    // the latest-subscription query only returns live statuses, so an expired one is absent
    stubDashboard({
      ledgerRows: [
        { _id: "2026-01", grossPaise: 49900, refundedPaise: 0, payments: 1 },
        { _id: "2026-02", grossPaise: 49900, refundedPaise: 49900, payments: 1 },
      ],
    });
    const res = await request(app).get("/admin/dashboard/plans").set("Cookie", cookie).expect(200);
    expect(res.body.activePlans).toEqual([]);
    expect(res.body.summary).toMatchObject({
      premiumUsers: 0,
      lifetimeRevenue: 499, // 998 collected − 499 refunded
      refundedTotal: 499,
      totalPayments: 2,
    });
  });

  it("counts plans ending within a week", async () => {
    const { cookie } = actAs("Manager");
    const owner = makeUser({ name: "Lee" });
    const sub = {
      _id: oid(), userId: owner._id, planId: "plan_T7QOKw1SWn3YA9", status: "cancelled",
      cancelledAt: new Date(), currentEnd: new Date(Date.now() + 3 * DAY), createdAt: new Date(),
    };
    stubDashboard({ owner, sub });
    const res = await request(app).get("/admin/dashboard/plans").set("Cookie", cookie).expect(200);
    expect(res.body.summary).toMatchObject({ expiringSoon: 1, cancellingUsers: 1, pastDueUsers: 0 });
  });

  it("counts failing payments, but not as 'ending' while there is time to recover", async () => {
    const { cookie } = actAs("Manager");
    const owner = makeUser({ name: "Lee" });
    const sub = {
      _id: oid(), userId: owner._id, planId: "plan_T7QOKw1SWn3YA9", status: "pending",
      currentEnd: new Date(Date.now() + 20 * DAY), createdAt: new Date(),
    };
    stubDashboard({ owner, sub });
    const res = await request(app).get("/admin/dashboard/plans").set("Cookie", cookie).expect(200);
    expect(res.body.summary).toMatchObject({ pastDueUsers: 1, expiringSoon: 0 });
  });

  it("hides unfinished checkouts and never-paid cancellations from recent activity", async () => {
    const { cookie } = actAs("Manager");
    stubDashboard({});
    await request(app).get("/admin/dashboard/plans").set("Cookie", cookie).expect(200);
    const filter = SubscriptionMock.find.mock.calls[0][0];
    expect(filter.status).toEqual({ $ne: "created" });
    expect(filter.$nor).toEqual([{ status: "cancelled", paidCount: 0 }]);
  });

  it("ignores subscriptions that belong to disabled users", async () => {
    const { cookie } = actAs("Manager");
    const owner = makeUser({ isDeleted: true });
    const sub = {
      _id: oid(), userId: owner._id, planId: "plan_T7QOKw1SWn3YA9", status: "active",
      currentEnd: new Date(Date.now() + 10 * DAY), createdAt: new Date(),
    };
    stubDashboard({ owner, sub, recentSubs: [] });

    const res = await request(app).get("/admin/dashboard/plans").set("Cookie", cookie).expect(200);

    expect(res.body.summary).toMatchObject({ premiumUsers: 0, payingSubscribers: 0, mrr: 0 });
    expect(res.body.activePlans).toEqual([]);
  });

  it("passes database failures to the error handler", async () => {
    const { cookie } = actAs("Manager");
    vi.spyOn(console, "error").mockImplementation(() => {});
    stubDashboard({});
    UserMock.countDocuments.mockRejectedValue(new Error("db down"));
    await request(app).get("/admin/dashboard/plans").set("Cookie", cookie).expect(500);
  });
});

describe("R2 storage usage", () => {
  const snapshot = { accounts: [{ name: "Production", storage: { usedBytes: 1 } }] };

  it("GET /admin/dashboard/storage/usage returns the cached snapshot, uncacheable", async () => {
    const { cookie } = actAs("Admin");
    getUsage.mockResolvedValue(snapshot);
    const res = await request(app)
      .get("/admin/dashboard/storage/usage")
      .set("Cookie", cookie)
      .expect(200);
    expect(res.body).toEqual(snapshot);
    expect(res.headers["cache-control"]).toBe("no-store");
    expect(getUsage).toHaveBeenCalledWith();
  });

  it("POST /admin/dashboard/storage/usage/refresh forces a fresh snapshot", async () => {
    const { cookie } = actAs("Admin");
    getUsage.mockResolvedValue(snapshot);
    const res = await request(app)
      .post("/admin/dashboard/storage/usage/refresh")
      .set("Cookie", cookie)
      .expect(200);
    expect(res.body).toEqual(snapshot);
    expect(res.headers["cache-control"]).toBe("no-store");
    expect(getUsage).toHaveBeenCalledWith({ force: true });
  });

  it("reports snapshot failures through the error handler", async () => {
    const { cookie } = actAs("Admin");
    vi.spyOn(console, "error").mockImplementation(() => {});
    getUsage.mockRejectedValue(new Error("cloudflare down"));
    await request(app).get("/admin/dashboard/storage/usage").set("Cookie", cookie).expect(500);
    getUsage.mockRejectedValue(new Error("cloudflare down"));
    const again = actAs("Admin");
    await request(app)
      .post("/admin/dashboard/storage/usage/refresh")
      .set("Cookie", again.cookie)
      .expect(500);
  });
});
