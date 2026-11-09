import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import { loadApp, request } from "../helpers/app.js";
import { redisMock } from "../helpers/redisMock.js";
import { UserMock, FileMock, DirectoryMock, SubscriptionMock } from "../helpers/modelMocks.js";
import { query } from "../helpers/query.js";
import { makeUser, oid, signedSidCookie } from "../helpers/fixtures.js";
import { deleteR2Files } from "../../services/cloudflareR2Service.js";

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
    redisMock.ft.search.mockResolvedValue({ total: 1, documents: [{ id: "session:x" }] });

    await request(app).delete(`/admin/users/${t._id}`).set("Cookie", cookie).expect(200);

    expect(deleteR2Files).toHaveBeenCalledWith([{ Key: `${fileId}.pdf` }], t._id);
    expect(FileMock.deleteMany).toHaveBeenCalled();
    expect(DirectoryMock.deleteMany).toHaveBeenCalled();
    expect(t.deleteOne).toHaveBeenCalledTimes(1);
    expect(redisMock.del).toHaveBeenCalledWith("session:x");
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
  it("summarises plans, revenue, storage alerts and recent subscriptions for managers", async () => {
    const { cookie } = actAs("Manager");
    const owner = makeUser({
      name: "Pat",
      email: "pat@example.com",
      maxStorageInBytes: 1000,
      usedStorageInBytes: 900,
    });
    const sub = {
      _id: oid(),
      userId: owner._id,
      planId: "plan_T7QOKw1SWn3YA9", // Pro, monthly
      status: "active",
      currentEnd: new Date(Date.now() + 10 * 24 * 60 * 60 * 1000),
      createdAt: new Date(),
    };
    UserMock.countDocuments.mockResolvedValue(7);
    SubscriptionMock.aggregate.mockResolvedValue([sub]);
    SubscriptionMock.find.mockReturnValue(
      query([{ ...sub, userId: { name: owner.name, email: owner.email, picture: owner.picture } }]),
    );
    UserMock.find.mockReturnValueOnce(query([owner])).mockReturnValueOnce(query([owner]));

    const res = await request(app).get("/admin/dashboard/plans").set("Cookie", cookie).expect(200);

    expect(res.body.summary).toEqual({
      totalUsers: 7,
      premiumUsers: 1,
      monthlyRevenue: 169,
      yearlyRevenue: 0,
    });
    expect(res.body.activePlans).toHaveLength(1);
    expect(res.body.activePlans[0]).toMatchObject({
      name: "Pat",
      planName: "Pro",
      cycle: "Monthly",
      status: "active",
    });
    expect(res.body.storageAlerts[0]).toMatchObject({ email: "pat@example.com", percentUsed: 90 });
    expect(res.body.recentSubscriptions[0]).toMatchObject({ name: "Pat", planName: "Pro" });
  });

  it("ignores subscriptions that belong to disabled users", async () => {
    const { cookie } = actAs("Manager");
    const owner = makeUser({ isDeleted: true });
    const sub = {
      _id: oid(),
      userId: owner._id,
      planId: "plan_T7QOKw1SWn3YA9",
      status: "active",
      currentEnd: new Date(Date.now() + 10 * 24 * 60 * 60 * 1000),
      createdAt: new Date(),
    };
    UserMock.countDocuments.mockResolvedValue(1);
    SubscriptionMock.aggregate.mockResolvedValue([sub]);
    SubscriptionMock.find.mockReturnValue(query([]));
    UserMock.find.mockReturnValueOnce(query([owner])).mockReturnValueOnce(query([owner]));

    const res = await request(app).get("/admin/dashboard/plans").set("Cookie", cookie).expect(200);

    expect(res.body.summary).toMatchObject({ premiumUsers: 0, monthlyRevenue: 0, yearlyRevenue: 0 });
    expect(res.body.activePlans).toEqual([]);
  });

  it("passes database failures to the error handler", async () => {
    const { cookie } = actAs("Manager");
    vi.spyOn(console, "error").mockImplementation(() => {});
    UserMock.countDocuments.mockRejectedValue(new Error("db down"));
    SubscriptionMock.aggregate.mockResolvedValue([]);
    SubscriptionMock.find.mockReturnValue(query([]));
    UserMock.find.mockReturnValue(query([]));
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
