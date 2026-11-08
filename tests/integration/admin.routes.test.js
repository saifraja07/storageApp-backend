import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import { loadApp, request } from "../helpers/app.js";
import { redisMock } from "../helpers/redisMock.js";
import { UserMock, FileMock, DirectoryMock } from "../helpers/modelMocks.js";
import { query } from "../helpers/query.js";
import { makeUser, oid, signedSidCookie } from "../helpers/fixtures.js";
import { deleteR2Files } from "../../services/cloudflareR2Service.js";

let app;
beforeAll(async () => {
  app = await loadApp();
});

beforeEach(() => {
  redisMock.ft.search.mockResolvedValue({ total: 0, documents: [] });
});

/**
 * Logs in as `role`. `checkAuth` runs twice on every admin request (server.js
 * mounts /admin behind it and adminRoutes.js adds it again), so the first two
 * User.findById calls are authentication; the third (if `target` is given) is
 * the controller's lookup of the user being managed.
 */
function actAs(role, target) {
  const actor = makeUser({ role });
  redisMock.json.get.mockResolvedValue({ userId: actor._id });
  UserMock.findById.mockReturnValueOnce(query(actor)).mockReturnValueOnce(query(actor));
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
    ["get", "/admin/plans-overview", "Manager"],
    ["get", "/admin/storage/usage", "Admin"],
    ["post", "/admin/storage/usage/refresh", "Admin"],
    ["post", "/admin/users/507f1f77bcf86cd799439011/logout", "Manager"],
    ["patch", "/admin/users/507f1f77bcf86cd799439011/soft", "Admin"],
    ["delete", "/admin/users/507f1f77bcf86cd799439011/hard", "SuperAdmin"],
    ["patch", "/admin/users/507f1f77bcf86cd799439011/recover", "Admin"],
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

describe("POST /admin/users/:userId/logout", () => {
  it("ends the target's sessions", async () => {
    const t = target("User");
    const { cookie } = actAs("Manager", t);
    redisMock.ft.search.mockResolvedValue({ total: 1, documents: [{ id: "session:x" }] });
    await request(app).post(`/admin/users/${t._id}/logout`).set("Cookie", cookie).expect(200);
    expect(redisMock.del).toHaveBeenCalledWith("session:x");
  });

  it("returns 404 for an unknown user", async () => {
    const { cookie } = actAs("Manager", null);
    await request(app).post(`/admin/users/${oid()}/logout`).set("Cookie", cookie).expect(404);
  });

  it("cannot act on someone with an equal or higher role", async () => {
    const { cookie } = actAs("Manager", target("Admin"));
    await request(app).post(`/admin/users/${oid()}/logout`).set("Cookie", cookie).expect(403);
    expect(redisMock.del).not.toHaveBeenCalled();
  });
});

describe("PATCH /admin/users/:userId/soft", () => {
  it("disables a lower-ranked user and ends their sessions", async () => {
    const t = target("Manager");
    const { cookie } = actAs("Admin", t);
    redisMock.ft.search.mockResolvedValue({ total: 1, documents: [{ id: "session:x" }] });
    await request(app).patch(`/admin/users/${t._id}/soft`).set("Cookie", cookie).expect(200);
    expect(t.isDeleted).toBe(true);
    expect(t.save).toHaveBeenCalledTimes(1);
    expect(redisMock.del).toHaveBeenCalledWith("session:x");
  });

  it("refuses to let admins disable themselves", async () => {
    const { actor, cookie } = actAs("Admin");
    const res = await request(app).patch(`/admin/users/${actor._id}/soft`).set("Cookie", cookie).expect(403);
    expect(res.body.error).toBe("Cannot delete yourself");
  });

  it("refuses to disable another admin", async () => {
    const t = target("Admin");
    const { cookie } = actAs("Admin", t);
    await request(app).patch(`/admin/users/${t._id}/soft`).set("Cookie", cookie).expect(403);
    expect(t.save).not.toHaveBeenCalled();
  });
});

describe("PATCH /admin/users/:userId/recover", () => {
  it("re-enables a disabled user", async () => {
    const t = target("User", { isDeleted: true });
    const { cookie } = actAs("Admin", t);
    await request(app).patch(`/admin/users/${t._id}/recover`).set("Cookie", cookie).expect(200);
    expect(t.isDeleted).toBe(false);
    expect(t.save).toHaveBeenCalledTimes(1);
  });
});

describe("DELETE /admin/users/:userId/hard", () => {
  it("lets a SuperAdmin permanently delete a user, their files and sessions", async () => {
    const t = target("Admin");
    const { cookie } = actAs("SuperAdmin", t);
    const fileId = oid();
    FileMock.find.mockReturnValue(query([{ _id: fileId, extension: ".pdf" }]));
    redisMock.ft.search.mockResolvedValue({ total: 1, documents: [{ id: "session:x" }] });

    await request(app).delete(`/admin/users/${t._id}/hard`).set("Cookie", cookie).expect(200);

    expect(deleteR2Files).toHaveBeenCalledWith([{ Key: `${fileId}.pdf` }], t._id);
    expect(FileMock.deleteMany).toHaveBeenCalled();
    expect(DirectoryMock.deleteMany).toHaveBeenCalled();
    expect(t.deleteOne).toHaveBeenCalledTimes(1);
    expect(redisMock.del).toHaveBeenCalledWith("session:x");
  });

  it("refuses to delete yourself", async () => {
    const { actor, cookie } = actAs("SuperAdmin");
    await request(app).delete(`/admin/users/${actor._id}/hard`).set("Cookie", cookie).expect(403);
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
    expect(res.body.error).toBe("Cannot change your own role");
  });

  it("lets an Admin promote a user to Manager", async () => {
    const t = target("User");
    const { cookie } = actAs("Admin", t);
    await setRole(cookie, t._id, "Manager").expect(200);
    expect(t.role).toBe("Manager");
    expect(t.save).toHaveBeenCalledTimes(1);
  });

  it("prevents privilege escalation: an Admin cannot create another Admin", async () => {
    const t = target("Manager");
    const { cookie } = actAs("Admin", t);
    const res = await setRole(cookie, t._id, "Admin").expect(403);
    expect(res.body.error).toBe("Cannot assign this role");
    expect(t.save).not.toHaveBeenCalled();
  });

  it("rejects a no-op role change", async () => {
    const t = target("User");
    const { cookie } = actAs("Admin", t);
    const res = await setRole(cookie, t._id, "User").expect(400);
    expect(res.body.error).toBe("User already has this role");
  });
});
