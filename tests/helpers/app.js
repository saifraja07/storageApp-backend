import { vi } from "vitest";
import request from "supertest";
import { redisMock } from "./redisMock.js";
import { UserMock } from "./modelMocks.js";
import { query } from "./query.js";
import { makeUser, signedSidCookie } from "./fixtures.js";

/** Imports the real Express app (all heavy dependencies are mocked by setup). */
export async function loadApp() {
  const { default: app } = await import("../../server.js");
  return app;
}

/**
 * Makes `checkAuth` accept the signed cookie and resolve to `user`.
 * Returns the cookie header to send with the request.
 */
export function loginAs(overrides = {}) {
  const user = makeUser(overrides);
  redisMock.json.get.mockResolvedValue({ userId: user._id });
  UserMock.findById.mockReturnValue(query(user));
  return { user, cookie: signedSidCookie() };
}

export { request };

/**
 * Makes `checkAuth` accept the signed cookie AND hands the controller `doc`
 * the next time it does `User.findById(...)`. Both calls hit the same mock, so
 * they are queued in order: checkAuth first, then the controller.
 */
export function loginAsWithDoc(overrides = {}, docExtras = {}) {
  const user = makeUser(overrides);
  const doc = { ...user, save: vi.fn().mockResolvedValue(undefined), ...docExtras };
  redisMock.json.get.mockResolvedValue({ userId: user._id });
  UserMock.findById.mockReturnValueOnce(query(user)).mockReturnValueOnce(doc);
  return { user, doc, cookie: signedSidCookie() };
}

/** A fake Mongo transaction session for controllers that call mongoose.startSession(). */
export function mockMongoSession(mongoose) {
  const session = {
    startTransaction: vi.fn(),
    commitTransaction: vi.fn().mockResolvedValue(undefined),
    abortTransaction: vi.fn().mockResolvedValue(undefined),
    endSession: vi.fn().mockResolvedValue(undefined),
  };
  vi.spyOn(mongoose, "startSession").mockResolvedValue(session);
  return session;
}
