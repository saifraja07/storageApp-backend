import crypto from "node:crypto";
import { Types } from "mongoose";

export const oid = () => new Types.ObjectId();

export function makeUser(overrides = {}) {
  return {
    _id: oid(),
    name: "Test User",
    email: "test@example.com",
    role: "User",
    isDeleted: false,
    rootDirId: oid(),
    accessDevice: 1,
    maxStorageInBytes: 500 * 1024 ** 2,
    usedStorageInBytes: 0,
    reservedStorage: 0,
    picture: "https://example.com/avatar.png",
    ...overrides,
  };
}

/** Builds a `sid` cookie signed exactly like cookie-parser does. */
export function signedSidCookie(sid = "test-sid", secret = process.env.SESSION_SECRET) {
  const signature = crypto
    .createHmac("sha256", secret)
    .update(sid)
    .digest("base64")
    .replace(/=+$/, "");
  return `sid=${encodeURIComponent(`s:${sid}.${signature}`)}`;
}

export const hmacHex = (secret, body) =>
  crypto.createHmac("sha256", secret).update(body).digest("hex");
