import redisClient from "../config/redis.js";
import { randomUUID } from "crypto";

const SESSION_TTL_SECONDS = 60 * 60 * 24 * 7; // 7 days


export async function createSession(res, userId) {
  const sessionId = randomUUID();
  const redisKey = `session:${sessionId}`;

  await redisClient.json.set(redisKey, "$", { userId, createdAt: Date.now() });
  await redisClient.expire(redisKey, SESSION_TTL_SECONDS);

  res.cookie("sid", sessionId, {
    httpOnly: true,
    signed: true,
    secure: true,
    sameSite: process.env.COOKIE_SAMESITE,
    maxAge: SESSION_TTL_SECONDS * 1000,
  });
}


// RediSearch returns only 10 documents per FT.SEARCH unless LIMIT is given.
// Page through ALL matches so no session is silently missed.
const SESSION_PAGE_SIZE = 1000;
const SESSION_MAX_PAGES = 50; // hard stop (50k sessions) so a bug can't loop forever

export async function searchAllSessions(query, options = {}) {
  const documents = [];
  let total = 0;
  for (let page = 0; page < SESSION_MAX_PAGES; page++) {
    const result = await redisClient.ft.search("userIdIdx", query, {
      ...options,
      LIMIT: { from: page * SESSION_PAGE_SIZE, size: SESSION_PAGE_SIZE },
    });
    total = result.total;
    documents.push(...result.documents);
    if (documents.length >= total || result.documents.length < SESSION_PAGE_SIZE) break;
  }
  return { total, documents };
}

export async function enforceDeviceLimit(userId, accessDevice) {
  let allSessions;
  try {
    allSessions = await searchAllSessions(`@userId:{${userId}}`, {
      RETURN: [],
      SORTBY: { BY: "createdAt", DIRECTION: "ASC" },
    });
  } catch (err) {
    // Fallback for older/mismatched index definitions that don't have
    // createdAt indexed yet — evict without strict ordering rather than
    // failing the login entirely.
    allSessions = await searchAllSessions(`@userId:{${userId}}`, { RETURN: [] });
  }

  // Same rule as before: keep at most (accessDevice - 1) old sessions so the
  // new login fits inside the plan's device limit.
  const excess = allSessions.total - accessDevice + 1;
  if (excess > 0) {
    const toEvict = allSessions.documents.slice(0, excess).map((doc) => doc.id);
    if (toEvict.length) {
      await redisClient.del(...toEvict);
    }
  }
}

/** Deletes ALL sessions belonging to a user (logout-all / account deletion / admin actions). */
export async function deleteUserSessions(userId, { exceptSessionId } = {}) {
  const allSessions = await searchAllSessions(`@userId:{${userId}}`, { RETURN: [] });
  const keepKey = exceptSessionId ? `session:${exceptSessionId}` : null;
  const sessionKeys = allSessions.documents
    .map((doc) => doc.id)
    .filter((id) => id !== keepKey);
  if (sessionKeys.length > 0) {
    await redisClient.del(...sessionKeys);
  }
}
