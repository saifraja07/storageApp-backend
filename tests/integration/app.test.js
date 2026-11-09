import { describe, it, expect, beforeAll, vi } from "vitest";
import { loadApp, loginAs, request } from "../helpers/app.js";
import { redisMock } from "../helpers/redisMock.js";
import { UserMock, DirectoryMock } from "../helpers/modelMocks.js";
import { query } from "../helpers/query.js";
import { makeUser, signedSidCookie } from "../helpers/fixtures.js";

let app;
beforeAll(async () => {
  app = await loadApp();
});

describe("GET /health", () => {
  it("responds 200 with a message (used by uptime checks / load balancer)", async () => {
    const res = await request(app).get("/health").expect(200);
    expect(res.body.message).toMatch(/storage app/i);
    expect(res.body.timeStamp).toBeTruthy();
  });
});

describe("security headers", () => {
  it("sets helmet headers and hides X-Powered-By", async () => {
    const res = await request(app).get("/health");
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
    expect(res.headers["x-frame-options"]).toBeDefined();
    expect(res.headers["x-powered-by"]).toBeUndefined();
  });
});

describe("CORS", () => {
  it("allows credentialed requests from every configured client origin", async () => {
    for (const origin of ["http://localhost:5173", "https://app.example.com"]) {
      const res = await request(app).get("/health").set("Origin", origin);
      expect(res.headers["access-control-allow-origin"]).toBe(origin);
      expect(res.headers["access-control-allow-credentials"]).toBe("true");
    }
  });

  it("does not grant access to other origins", async () => {
    const res = await request(app).get("/health").set("Origin", "https://evil.example.org");
    expect(res.headers["access-control-allow-origin"]).toBeUndefined();
  });

  it("answers preflight requests", async () => {
    const res = await request(app)
      .options("/user/login")
      .set("Origin", "http://localhost:5173")
      .set("Access-Control-Request-Method", "POST");
    expect(res.status).toBe(204);
    expect(res.headers["access-control-allow-origin"]).toBe("http://localhost:5173");
  });
});

describe("unknown routes and error handling", () => {
  it("returns a JSON 404 for unknown routes", async () => {
    const res = await request(app).get("/does-not-exist").expect(404);
    expect(res.body).toMatchObject({ success: false, message: "Route not found" });
  });

  it("returns 400 JSON for malformed request bodies", async () => {
    const res = await request(app)
      .post("/auth/otp/send")
      .set("Content-Type", "application/json")
      .send("{not json")
      .expect(400);
    expect(res.body.success).toBe(false);
  });

  it("hides internal error details from clients on 5xx", async () => {
    const { cookie } = loginAs();
    DirectoryMock.findOne.mockImplementation(() => {
      throw new Error("mongo exploded: secret detail");
    });
    vi.spyOn(console, "error").mockImplementation(() => {});

    const res = await request(app).get("/directories").set("Cookie", cookie).expect(500);

    expect(res.body.success).toBe(false);
    expect(res.body.message).toBe("Internal Server Error");
    expect(JSON.stringify(res.body)).not.toMatch(/secret detail|mongo exploded|stack/i);
  });
});

describe("authentication guard on protected routes", () => {
  const protectedRoutes = [
    ["get", "/users/me"],
    ["post", "/auth/logout"],
    ["post", "/auth/logout-all"],
    ["patch", "/users/me/password"],
    ["patch", "/users/me/profile"],
    ["patch", "/users/me/deactivation"],
    ["delete", "/users/me"],
    ["post", "/users/me/bulk-delete"],
    ["get", "/directories"],
    ["post", "/directories"],
    ["post", "/directories/507f1f77bcf86cd799439011/children"],
    ["get", "/files/507f1f77bcf86cd799439011"],
    ["post", "/files/uploads/initiate"],
    ["post", "/files/uploads/507f1f77bcf86cd799439011/complete"],
    ["post", "/files/uploads/507f1f77bcf86cd799439011/cancel"],
    ["get", "/subscriptions/active"],
    ["post", "/subscriptions"],
    ["get", "/admin/users"],
    ["get", "/admin/dashboard/plans"],
    ["get", "/admin/dashboard/storage/usage"],
    ["post", "/admin/dashboard/storage/usage/refresh"],
  ];

  it.each(protectedRoutes)("%s %s requires a session", async (method, path) => {
    const res = await request(app)[method](path).expect(401);
    expect(res.body).toEqual({ error: "Active session not found!" });
  });

  it("rejects a forged (unsigned) session cookie", async () => {
    const res = await request(app).get("/users/me").set("Cookie", "sid=forged-session-id").expect(401);
    expect(res.body.error).toBe("Active session not found!");
    expect(redisMock.json.get).not.toHaveBeenCalled();
  });

  it("rejects a cookie signed with the wrong secret", async () => {
    const cookie = signedSidCookie("abc", "some-other-secret");
    await request(app).get("/users/me").set("Cookie", cookie).expect(401);
    expect(redisMock.json.get).not.toHaveBeenCalled();
  });

  it("rejects a correctly signed cookie whose session expired in Redis", async () => {
    redisMock.json.get.mockResolvedValue(null);
    await request(app).get("/users/me").set("Cookie", signedSidCookie()).expect(401);
  });

  it("blocks disabled accounts with 403", async () => {
    const user = makeUser({ isDeleted: true });
    redisMock.json.get.mockResolvedValue({ userId: user._id });
    UserMock.findById.mockReturnValue(query(user));
    const res = await request(app).get("/users/me").set("Cookie", signedSidCookie()).expect(403);
    expect(res.body.error).toMatch(/disabled/i);
  });

  it("lets a logged-in user through", async () => {
    const { cookie, user } = loginAs();
    const res = await request(app).get("/users/me").set("Cookie", cookie).expect(200);
    expect(res.body.email).toBe(user.email);
  });
});

describe("retired endpoints", () => {
  const retired = [
    ["post", "/user/register"],
    ["post", "/user/login"],
    ["post", "/user/logout"],
    ["post", "/user/logout-all"],
    ["get", "/user"],
    ["patch", "/user/update-profile"],
    ["patch", "/user/change-password"],
    ["patch", "/user/soft-delete"],
    ["delete", "/user/hard-delete"],
    ["post", "/user/bulk-delete"],
    ["post", "/auth/send-otp"],
    ["post", "/auth/verify-otp"],
    ["get", "/file/507f1f77bcf86cd799439011"],
    ["post", "/file/upload/initiate"],
    ["get", "/directory"],
    ["get", "/directory/path/507f1f77bcf86cd799439011"],
    ["get", "/subscription/active"],
    ["post", "/webhook/razorpay"],
    ["get", "/admin/plans-overview"],
    ["get", "/admin/storage/usage"],
    ["post", "/admin/storage/usage/refresh"],
    ["post", "/admin/users/507f1f77bcf86cd799439011/logout"],
    ["patch", "/admin/users/507f1f77bcf86cd799439011/soft"],
    ["patch", "/admin/users/507f1f77bcf86cd799439011/recover"],
    ["delete", "/admin/users/507f1f77bcf86cd799439011/hard"],
  ];

  it.each(retired)("%s %s is no longer served", async (method, path) => {
    // Authenticated, so paths under a guarded mount (/admin) reach the 404 handler too.
    const { cookie } = loginAs({ role: "SuperAdmin" });
    const res = await request(app)[method](path).set("Cookie", cookie).send({});
    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ success: false, message: "Route not found" });
  });
});
