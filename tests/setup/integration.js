import { vi } from "vitest";

// Skips server.js's DB connection, app.listen() and background intervals
// (the same switch the Lambda deployment uses).
process.env.AWS_LAMBDA_FUNCTION_NAME = "vitest";

vi.mock("../../config/redis.js", async () => ({
  default: (await import("../helpers/redisMock.js")).redisMock,
}));

// ── Mongoose models ──────────────────────────────────────────────────────────
vi.mock("../../models/userModel.js", async () => ({
  default: (await import("../helpers/modelMocks.js")).UserMock,
}));
vi.mock("../../models/fileModel.js", async () => ({
  default: (await import("../helpers/modelMocks.js")).FileMock,
}));
vi.mock("../../models/directoryModel.js", async () => ({
  default: (await import("../helpers/modelMocks.js")).DirectoryMock,
}));
vi.mock("../../models/subscriptionModel.js", async (importOriginal) => ({
  // keep the real status list exported by the model file
  SUBSCRIPTION_STATUSES: (await importOriginal()).SUBSCRIPTION_STATUSES,
  default: (await import("../helpers/modelMocks.js")).SubscriptionMock,
}));
vi.mock("../../models/webhookEventModel.js", async () => ({
  default: (await import("../helpers/modelMocks.js")).WebhookEventMock,
}));
vi.mock("../../models/otpModel.js", async () => ({
  default: (await import("../helpers/modelMocks.js")).OtpMock,
}));

// ── Outbound services (R2, e-mail, Google) ───────────────────────────────────
vi.mock("../../services/cloudflareR2Service.js", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    // pure URL helpers stay real
    getProfilePictureURL: actual.getProfilePictureURL,
    getProfilePictureKeyFromURL: actual.getProfilePictureKeyFromURL,
    isOwnedProfilePictureURL: actual.isOwnedProfilePictureURL,
    // anything that talks to R2 is mocked
    createUploadSignedUrl: vi.fn(),
    createGetSignedUrl: vi.fn(),
    deleteR2File: vi.fn(),
    deleteR2Files: vi.fn(),
    getR2FileMetaData: vi.fn(),
    uploadProfilePicture: vi.fn(),
    deleteProfilePicture: vi.fn(),
  };
});
vi.mock("../../services/sendOtpService.js", () => ({ sendOtpService: vi.fn() }));
vi.mock("../../services/googleAuthService.js", () => ({
  getUserFromAuthCode: vi.fn(),
}));
vi.mock("../../services/storageService.js", () => ({
  upgradeStorage: vi.fn(),
  downgradeStorage: vi.fn(),
}));

// ── Rate limiting ────────────────────────────────────────────────────────────
// Pass-through so repeated requests in a test file are not throttled/delayed.
// The real limiter is covered in tests/unit/middleware/limiter.test.js.
vi.mock("../../middleWares/limiterMiddleware.js", () => ({
  rateLimiter: () => (_req, _res, next) => next(),
  throttle: () => (_req, _res, next) => next(),
}));
