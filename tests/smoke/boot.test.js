import { describe, it, expect, vi } from "vitest";

// A failing smoke test means the deployment would not even start.

vi.mock("../../config/db.js", () => ({ connectDB: vi.fn() }));

describe("application boot", () => {
  it("server.js loads and exports the Express app", async () => {
    const { default: app } = await import("../../server.js");
    expect(typeof app).toBe("function");
    expect(typeof app.handle).toBe("function");
  });

  it("every route module loads and exports a router", async () => {
    const names = ["admin", "auth", "directory", "file", "subscription", "user", "webhook"];
    for (const name of names) {
      const mod = await import(`../../routes/${name}Routes.js`);
      expect(typeof mod.default, `${name}Routes`).toBe("function");
      expect(mod.default.stack?.length, `${name}Routes has routes`).toBeGreaterThan(0);
    }
  });

  it("the Lambda entrypoint exports a handler function", async () => {
    const { handler } = await import("../../lambda.js");
    expect(typeof handler).toBe("function");
  });

  it("the webhook controller starts (plan config is in sync with the validator)", async () => {
    const mod = await import("../../controllers/webhookController.js");
    expect(typeof mod.razorpayWebhook).toBe("function");
  });

  it("serves /health through the Lambda handler", async () => {
    const { handler } = await import("../../lambda.js");
    const response = await handler(
      {
        version: "2.0",
        routeKey: "$default",
        rawPath: "/health",
        rawQueryString: "",
        headers: { host: "example.com" },
        requestContext: { http: { method: "GET", path: "/health", sourceIp: "127.0.0.1" } },
        isBase64Encoded: false,
      },
      {},
    );
    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body).message).toMatch(/storage app/i);
  });
});
