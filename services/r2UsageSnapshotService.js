import { randomUUID } from "node:crypto";
import {
  getR2Accounts,
  R2_FREE_TIER,
  R2_USAGE_CACHE_KEY,
  R2_USAGE_CACHE_TTL_SECONDS,
  R2_USAGE_FAILURE_CACHE_TTL_SECONDS,
  R2_USAGE_LAST_GOOD_KEY,
  R2_USAGE_LOCK_KEY,
  R2_USAGE_LOCK_POLL_MS,
  R2_USAGE_LOCK_TTL_SECONDS,
  R2_USAGE_LOCK_WAIT_MS,
} from "../config/r2Usage.js";
import {
  fetchAccountUsage as defaultFetchAccountUsage,
  R2UsageError,
} from "./r2UsageService.js";

const round2 = (n) => Math.round(n * 100) / 100;
const remaining = (used, allowance) => Math.max(0, allowance - used);

function buildStorage(storage) {
  const usedBytes = storage.standardBytes;
  const allowanceBytes = R2_FREE_TIER.storageBytes;
  return {
    // Standard storage only: the free tier does not cover Infrequent Access.
    usedBytes,
    allowanceBytes,
    remainingBytes: remaining(usedBytes, allowanceBytes),
    percentage: allowanceBytes > 0 ? round2((usedBytes / allowanceBytes) * 100) : 0,
    infrequentAccessBytes: storage.infrequentAccessBytes,
  };
}

function buildOperations(operations) {
  const entry = (used, allowance) => ({
    used,
    allowance,
    remaining: remaining(used, allowance),
  });
  return {
    classA: entry(operations.classA, R2_FREE_TIER.classAOperations),
    classB: entry(operations.classB, R2_FREE_TIER.classBOperations),
  };
}

function publicError(err) {
  // Only our own R2UsageError carries a message that is safe to expose.
  if (err?.name === "R2UsageError") return { code: err.code, message: err.message };
  return { code: "UNKNOWN", message: "Unexpected error while fetching usage" };
}

function busyError() {
  const err = new Error("R2 usage refresh is already in progress, try again shortly");
  err.statusCode = 503;
  return err;
}

// Redis is injected so the service stays testable and never opens a
// connection by itself.
export function createR2UsageSnapshotService({
  redis,
  fetchAccountUsage = defaultFetchAccountUsage,
  accounts = getR2Accounts(),
  now = () => new Date(),
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
} = {}) {
  let inFlight = null;
  const accountKeys = Object.keys(accounts).sort();
  const cacheKey = `${R2_USAGE_CACHE_KEY}:${accountKeys.join("-")}`;
  const lastGoodKey = `${R2_USAGE_LAST_GOOD_KEY}:${accountKeys.join("-")}`;
  const lockKey = `${R2_USAGE_LOCK_KEY}:${accountKeys.join("-")}`;

  async function readJson(key) {
    const raw = await redis.get(key);
    if (!raw) return null;
    try {
      return JSON.parse(raw);
    } catch (err) {
      console.warn(`[r2-usage] ignoring unreadable cache entry "${key}": ${err.message}`);
      return null;
    }
  }

  async function refreshAccount(key, account, previous) {
    try {
      const { storage, operations } = await fetchAccountUsage(account, { now: now() });

      // Cloudflare can briefly return no storage rows. Never replace a
      // known-good, non-zero storage figure with that.
      if (!storage.measured && previous?.storage?.usedBytes > 0) {
        throw new R2UsageError(
          "INCOMPLETE_DATA",
          "Cloudflare returned no storage measurement"
        );
      }

      const data = {
        storage: buildStorage(storage),
        operations: buildOperations(operations),
        lastSyncedAt: now().toISOString(),
      };
      return { data, fresh: true };
    } catch (err) {
      console.error(
        `[r2-usage] refresh failed for ${key}: ${err?.code ?? "UNKNOWN"} - ${err?.message}`,
        err?.cause ?? ""
      );
      const error = publicError(err);
      if (previous) {
        return { data: previous, fresh: false, status: "stale", error };
      }
      return {
        data: { storage: null, operations: null, lastSyncedAt: null },
        fresh: false,
        status: error.code === "CONFIG_MISSING" ? "unconfigured" : "error",
        error,
      };
    }
  }

  async function refreshAll() {
    const lastGood = (await readJson(lastGoodKey)) ?? {};

    const entries = await Promise.all(
      Object.entries(accounts).map(async ([key, account]) => [
        key,
        account,
        await refreshAccount(key, account, lastGood[key]),
      ])
    );

    const nextLastGood = { ...lastGood };
    const snapshotAccounts = {};
    let allHealthy = true;

    for (const [key, account, result] of entries) {
      if (result.fresh) nextLastGood[key] = result.data;
      else allHealthy = false;

      snapshotAccounts[key] = {
        label: account.label,
        storage: result.data.storage,
        operations: result.data.operations,
        status: result.fresh ? "healthy" : result.status,
        lastSyncedAt: result.data.lastSyncedAt,
        error: result.fresh ? null : result.error,
      };
    }

    // Persist the last-good data only for accounts that refreshed.
    if (entries.some(([, , r]) => r.fresh)) {
      await redis.set(lastGoodKey, JSON.stringify(nextLastGood));
    }

    const snapshot = { accounts: snapshotAccounts, generatedAt: now().toISOString() };
    await redis.set(cacheKey, JSON.stringify(snapshot), {
      expiration: {
        type: "EX",
        value: allHealthy ? R2_USAGE_CACHE_TTL_SECONDS : R2_USAGE_FAILURE_CACHE_TTL_SECONDS,
      },
    });
    return snapshot;
  }

  async function releaseLock(token) {
    // The lock also expires on its own, so a missed release is harmless.
    if ((await redis.get(lockKey)) === token) {
      await redis.del(lockKey);
    }
  }

  async function waitForOtherRefresh(startedAtMs) {
    const deadline = Date.now() + R2_USAGE_LOCK_WAIT_MS;
    while (Date.now() < deadline) {
      await sleep(R2_USAGE_LOCK_POLL_MS);
      const cached = await readJson(cacheKey);
      if (cached && Date.parse(cached.generatedAt) >= startedAtMs) return cached;
    }
    throw busyError();
  }

  async function refreshWithLock() {
    const startedAtMs = now().getTime();
    const token = randomUUID();
    const acquired = await redis.set(lockKey, token, {
      condition: "NX",
      expiration: { type: "EX", value: R2_USAGE_LOCK_TTL_SECONDS },
    });

    if (acquired) {
      try {
        return await refreshAll();
      } finally {
        await releaseLock(token);
      }
    }
    // Another process is refreshing: reuse its result instead of calling
    // Cloudflare again.
    return waitForOtherRefresh(startedAtMs);
  }

  // Cached snapshot if present, otherwise a fresh fetch. `force` skips the
  // cache read (manual refresh).
  async function getUsage({ force = false } = {}) {
    if (!force) {
      const cached = await readJson(cacheKey);
      if (cached) return cached;
    }
    // Same-process callers share one refresh.
    if (!inFlight) {
      inFlight = refreshWithLock().finally(() => {
        inFlight = null;
      });
    }
    return inFlight;
  }

  return { getUsage };
}
