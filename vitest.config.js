import { defineConfig } from "vitest/config";

// Test configuration. Tests never touch MongoDB, Redis, Cloudflare R2,
// Razorpay, Google or Resend — every external dependency is mocked, so the
// suite runs offline in CI in a few seconds.
//
//   unit         pure logic: validators, middleware, utils, services, jobs, models
//   integration  the real Express app (routes + middleware + controllers)
//                driven through HTTP with supertest; DB/Redis/R2 mocked
//   smoke        "can the app boot and is the deployment config sane?"
const shared = {
  environment: "node",
  mockReset: true,
  unstubEnvs: true,
  testTimeout: 15000,
};

export default defineConfig({
  test: {
    coverage: {
      provider: "v8",
      reporter: ["text-summary", "lcov"],
      include: [
        "controllers/**",
        "middleWares/**",
        "services/**",
        "utils/**",
        "validators/**",
        "jobs/**",
        "models/**",
        "config/plans.js",
      ],
    },
    projects: [
      {
        test: {
          ...shared,
          name: "unit",
          include: ["tests/unit/**/*.test.js"],
          setupFiles: ["./tests/setup/env.js", "./tests/setup/redis.js"],
        },
      },
      {
        test: {
          ...shared,
          name: "integration",
          include: ["tests/integration/**/*.test.js"],
          setupFiles: ["./tests/setup/env.js", "./tests/setup/integration.js"],
        },
      },
      {
        test: {
          ...shared,
          name: "smoke",
          include: ["tests/smoke/**/*.test.js"],
          setupFiles: ["./tests/setup/env.js", "./tests/setup/integration.js"],
        },
      },
    ],
  },
});
