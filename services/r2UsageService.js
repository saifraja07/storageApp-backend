import {
  CLASS_A_OPERATIONS,
  CLASS_B_OPERATIONS,
  CLOUDFLARE_GRAPHQL_URL,
  CLOUDFLARE_REQUEST_TIMEOUT_MS,
  FREE_OPERATIONS,
  GRAPHQL_ROW_LIMIT,
  MAX_QUERY_RANGE_DAYS,
  STORAGE_LOOKBACK_DAYS,
} from "../config/r2Usage.js";

const DAY_MS = 24 * 60 * 60 * 1000;

// Error with a stable code and a message that is safe to show to an admin.
// Raw Cloudflare messages / URLs are logged by the caller, never returned.
export class R2UsageError extends Error {
  constructor(code, message, { cause } = {}) {
    super(message, { cause });
    this.name = "R2UsageError";
    this.code = code;
  }
}

// One request per account, both datasets. Storage is ordered newest-first so
// that, if the row limit were ever hit, the oldest rows are the ones dropped.
export const USAGE_QUERY = `
query R2Usage(
  $accountTag: String!
  $storageStart: Time!
  $storageEnd: Time!
  $opsStart: Time!
  $opsEnd: Time!
) {
  viewer {
    accounts(filter: { accountTag: $accountTag }) {
      storage: r2StorageAdaptiveGroups(
        limit: ${GRAPHQL_ROW_LIMIT}
        filter: { datetime_geq: $storageStart, datetime_leq: $storageEnd }
        orderBy: [datetime_DESC]
      ) {
        max {
          payloadSize
          metadataSize
        }
        dimensions {
          datetime
          bucketName
          storageClass
        }
      }
      operations: r2OperationsAdaptiveGroups(
        limit: ${GRAPHQL_ROW_LIMIT}
        filter: { datetime_geq: $opsStart, datetime_leq: $opsEnd }
      ) {
        sum {
          requests
        }
        dimensions {
          actionType
          storageClass
        }
      }
    }
  }
}`;

// Billing month = current UTC calendar month. Operations are queried from the
// first instant of that month until now; the start is clamped so the range can
// never exceed Cloudflare's 31-day maximum.
export function getQueryWindows(now = new Date()) {
  const end = new Date(now.getTime());
  const monthStart = new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth(), 1));
  const earliestAllowed = new Date(end.getTime() - MAX_QUERY_RANGE_DAYS * DAY_MS);
  const opsStart = monthStart < earliestAllowed ? earliestAllowed : monthStart;
  const storageStart = new Date(end.getTime() - STORAGE_LOOKBACK_DAYS * DAY_MS);

  return {
    opsStart: opsStart.toISOString(),
    opsEnd: end.toISOString(),
    storageStart: storageStart.toISOString(),
    storageEnd: end.toISOString(),
  };
}

function isInfrequentAccess(storageClass) {
  return (
    typeof storageClass === "string" &&
    storageClass.replace(/[\s_-]/g, "").toLowerCase() === "infrequentaccess"
  );
}

function toNonNegativeNumber(value, field) {
  const n = typeof value === "string" && value.trim() !== "" ? Number(value) : value;
  if (typeof n !== "number" || !Number.isFinite(n) || n < 0) {
    throw new R2UsageError("MALFORMED_RESPONSE", "Cloudflare returned an unexpected response");
  }
  return n;
}

// Takes the latest measurement for every (bucket, storage class) pair and sums
// those. Historical measurements are never added together.
export function summarizeStorage(rows) {
  if (!Array.isArray(rows)) {
    throw new R2UsageError("MALFORMED_RESPONSE", "Cloudflare returned an unexpected response");
  }

  const latest = new Map();
  for (const row of rows) {
    const dims = row?.dimensions;
    const max = row?.max;
    const time = Date.parse(dims?.datetime);
    if (!dims || !max || Number.isNaN(time)) {
      throw new R2UsageError("MALFORMED_RESPONSE", "Cloudflare returned an unexpected response");
    }
    const bytes =
      toNonNegativeNumber(max.payloadSize, "payloadSize") +
      toNonNegativeNumber(max.metadataSize, "metadataSize");
    const infrequent = isInfrequentAccess(dims.storageClass);
    const key = `${dims.bucketName ?? ""}\u0000${infrequent ? "IA" : "STD"}`;

    const existing = latest.get(key);
    if (!existing || time > existing.time) {
      latest.set(key, { time, bytes, infrequent });
    }
  }

  let standardBytes = 0;
  let infrequentAccessBytes = 0;
  for (const entry of latest.values()) {
    if (entry.infrequent) infrequentAccessBytes += entry.bytes;
    else standardBytes += entry.bytes;
  }

  return {
    standardBytes,
    infrequentAccessBytes,
    // False when Cloudflare returned no storage rows at all.
    measured: latest.size > 0,
  };
}

// Splits request counts into Class A / Class B. Free operations are ignored on
// purpose (documented as free). Infrequent Access requests are excluded because
// the free tier only covers Standard. Unknown action types are never silently
// dropped: they are returned so the caller can log them.
export function summarizeOperations(rows) {
  if (!Array.isArray(rows)) {
    throw new R2UsageError("MALFORMED_RESPONSE", "Cloudflare returned an unexpected response");
  }

  let classA = 0;
  let classB = 0;
  const unknownActionTypes = {};

  for (const row of rows) {
    const actionType = row?.dimensions?.actionType;
    if (typeof actionType !== "string" || !row?.sum) {
      throw new R2UsageError("MALFORMED_RESPONSE", "Cloudflare returned an unexpected response");
    }
    const requests = toNonNegativeNumber(row.sum.requests, "requests");

    if (FREE_OPERATIONS.has(actionType)) continue;

    if (CLASS_A_OPERATIONS.has(actionType) || CLASS_B_OPERATIONS.has(actionType)) {
      if (isInfrequentAccess(row.dimensions.storageClass)) continue;
      if (CLASS_A_OPERATIONS.has(actionType)) classA += requests;
      else classB += requests;
    } else {
      unknownActionTypes[actionType] = (unknownActionTypes[actionType] ?? 0) + requests;
    }
  }

  return { classA, classB, unknownActionTypes };
}

// Validates the GraphQL response body and turns it into plain numbers.
export function parseUsageResponse(body) {
  if (!body || typeof body !== "object") {
    throw new R2UsageError("MALFORMED_RESPONSE", "Cloudflare returned an unexpected response");
  }
  if (Array.isArray(body.errors) && body.errors.length > 0) {
    const authz = body.errors.some((e) => /authz|authenticat|unauthori[sz]ed|permission/i.test(
      `${e?.extensions?.code ?? ""} ${e?.message ?? ""}`
    ));
    throw new R2UsageError(
      authz ? "AUTH_FAILED" : "GRAPHQL_ERROR",
      authz
        ? "Cloudflare rejected the API token or account ID"
        : "Cloudflare could not run the usage query",
      { cause: body.errors }
    );
  }

  const accounts = body?.data?.viewer?.accounts;
  if (!Array.isArray(accounts) || accounts.length !== 1) {
    // An empty list means the account ID is wrong or the token cannot see it.
    throw new R2UsageError("NO_ACCOUNT_DATA", "Cloudflare returned no data for this account");
  }

  const storage = summarizeStorage(accounts[0].storage);
  const operations = summarizeOperations(accounts[0].operations);
  return { storage, operations };
}

// Fetches and normalizes usage for ONE account using ITS OWN credentials.
export async function fetchAccountUsage(
  account,
  { fetchImpl = fetch, now = new Date(), env = process.env } = {}
) {
  const accountId = env[account.accountIdEnv];
  const apiToken = env[account.apiTokenEnv];
  if (!accountId || !apiToken) {
    throw new R2UsageError(
      "CONFIG_MISSING",
      `${account.label} credentials are not configured`
    );
  }

  const windows = getQueryWindows(now);

  let response;
  try {
    response = await fetchImpl(CLOUDFLARE_GRAPHQL_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiToken}`,
      },
      body: JSON.stringify({
        query: USAGE_QUERY,
        variables: { accountTag: accountId, ...windows },
      }),
      signal: AbortSignal.timeout(CLOUDFLARE_REQUEST_TIMEOUT_MS),
    });
  } catch (err) {
    if (err?.name === "TimeoutError" || err?.name === "AbortError") {
      throw new R2UsageError("TIMEOUT", "Cloudflare request timed out", { cause: err });
    }
    throw new R2UsageError("NETWORK_ERROR", "Could not reach Cloudflare", { cause: err });
  }

  if (!response.ok) {
    const code =
      response.status === 401 || response.status === 403
        ? "AUTH_FAILED"
        : response.status === 429
          ? "RATE_LIMITED"
          : "HTTP_ERROR";
    const message =
      code === "AUTH_FAILED"
        ? "Cloudflare rejected the API token or account ID"
        : code === "RATE_LIMITED"
          ? "Cloudflare rate limit reached"
          : `Cloudflare returned HTTP ${response.status}`;
    throw new R2UsageError(code, message);
  }

  let body;
  try {
    body = await response.json();
  } catch (err) {
    throw new R2UsageError("MALFORMED_RESPONSE", "Cloudflare returned an unexpected response", {
      cause: err,
    });
  }

  const { storage, operations } = parseUsageResponse(body);

  const unknownTypes = Object.keys(operations.unknownActionTypes);
  if (unknownTypes.length > 0) {
    console.warn(
      `[r2-usage] ${account.label}: unclassified R2 action types (not counted): ` +
        JSON.stringify(operations.unknownActionTypes)
    );
  }

  return { storage, operations };
}
