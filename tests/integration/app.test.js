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
      .post("/auth/send-otp")
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

    const res = await request(app).get("/directory").set("Cookie", cookie).expect(500);

    expect(res.body.success).toBe(false);
    expect(res.body.message).toBe("Internal Server Error");
    expect(JSON.stringify(res.body)).not.toMatch(/secret detail|mongo exploded|stack/i);
  });
});

describe("authentication guard on protected routes", () => {
  const protectedRoutes = [
    ["get", "/user"],
    ["post", "/user/logout"],
    ["post", "/user/logout-all"],
    ["patch", "/user/change-password"],
    ["patch", "/user/soft-delete"],
    ["delete", "/user/hard-delete"],
    ["post", "/user/bulk-delete"],
    ["get", "/directory"],
    ["post", "/directory"],
    ["get", "/file/507f1f77bcf86cd799439011"],
    ["post", "/file/upload/initiate"],
    ["get", "/subscription/active"],
    ["post", "/subscription"],
    ["get", "/admin/users"],
    ["get", "/admin/storage/usage"],
  ];

  it.each(protectedRoutes)("%s %s requires a session", async (method, path) => {
    const res = await request(app)[method](path).expect(401);
    expect(res.body).toEqual({ error: "Active session not found!" });
  });

  it("rejects a forged (unsigned) session cookie", async () => {
    const res = await request(app).get("/user").set("Cookie", "sid=forged-session-id").expect(401);
    expect(res.body.error).toBe("Active session not found!");
    expect(redisMock.json.get).not.toHaveBeenCalled();
  });

  it("rejects a cookie signed with the wrong secret", async () => {
    const cookie = signedSidCookie("abc", "some-other-secret");
    await request(app).get("/user").set("Cookie", cookie).expect(401);
    expect(redisMock.json.get).not.toHaveBeenCalled();
  });

  it("rejects a correctly signed cookie whose session expired in Redis", async () => {
    redisMock.json.get.mockResolvedValue(null);
    await request(app).get("/user").set("Cookie", signedSidCookie()).expect(401);
  });

  it("blocks disabled accounts with 403", async () => {
    const user = makeUser({ isDeleted: true });
    redisMock.json.get.mockResolvedValue({ userId: user._id });
    UserMock.findById.mockReturnValue(query(user));
    const res = await request(app).get("/user").set("Cookie", signedSidCookie()).expect(403);
    expect(res.body.error).toMatch(/disabled/i);
  });

  it("lets a logged-in user through", async () => {
    const { cookie, user } = loginAs();
    const res = await request(app).get("/user").set("Cookie", cookie).expect(200);
    expect(res.body.email).toBe(user.email);
  });
});
