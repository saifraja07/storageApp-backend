import { vi } from "vitest";

// A Mongoose-model stand-in: every static method (find, findOne, updateOne…)
// is created lazily as a vi.fn(), so tests only configure what they use.
export function createModelMock() {
  const fns = {};
  return new Proxy(fns, {
    get(target, prop) {
      if (prop === "then" || typeof prop === "symbol") return undefined;
      if (!(prop in target)) target[prop] = vi.fn();
      return target[prop];
    },
  });
}

export const UserMock = createModelMock();
export const FileMock = createModelMock();
export const DirectoryMock = createModelMock();
export const SubscriptionMock = createModelMock();
export const WebhookEventMock = createModelMock();
export const OtpMock = createModelMock();
