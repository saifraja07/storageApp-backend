// Production is always monitored.
// Personal R2 monitoring is optional and enabled only when both credentials exist.

export function getR2Accounts(env = process.env) {
  const accounts = {
    production: {
      label: "Production R2",
      accountIdEnv: "R2_ACCOUNT_ID",
      apiTokenEnv: "R2_API_TOKEN",
    },
  };

  if (env.PERSONAL_R2_ACCOUNT_ID && env.PERSONAL_R2_API_TOKEN) {
    accounts.personal = {
      label: "Personal R2",
      accountIdEnv: "PERSONAL_R2_ACCOUNT_ID",
      apiTokenEnv: "PERSONAL_R2_API_TOKEN",
    };
  }

  return accounts;
}

export const R2_ACCOUNTS = getR2Accounts();


// Cloudflare R2 free-tier allowances, per account (hardcoded on purpose).
// The free tier applies to Standard storage only, not Infrequent Access.
export const R2_FREE_TIER = {
  storageBytes: 10 * 1_000_000_000,
  classAOperations: 1_000_000,
  classBOperations: 10_000_000,
};

// Operation classification, from Cloudflare's R2 pricing documentation
// (https://developers.cloudflare.com/r2/pricing/). Keys are the `actionType`
// values returned by the r2OperationsAdaptiveGroups dataset.
export const CLASS_A_OPERATIONS = new Set([
  "ListBuckets",
  "PutBucket",
  "ListObjects",
  "PutObject",
  "CopyObject",
  "CompleteMultipartUpload",
  "CreateMultipartUpload",
  "LifecycleStorageTierTransition",
  "ListMultipartUploads",
  "UploadPart",
  "UploadPartCopy",
  "ListParts",
  "PutBucketEncryption",
  "PutBucketCors",
  "PutBucketLifecycleConfiguration",
]);

export const CLASS_B_OPERATIONS = new Set([
  "HeadBucket",
  "HeadObject",
  "GetObject",
  "UsageSummary",
  "GetBucketEncryption",
  "GetBucketLocation",
  "GetBucketCors",
  "GetBucketLifecycleConfiguration",
]);

// Documented as free: they count toward neither class.
export const FREE_OPERATIONS = new Set([
  "DeleteObject",
  "DeleteBucket",
  "AbortMultipartUpload",
]);

// Cloudflare GraphQL Analytics API.
export const CLOUDFLARE_GRAPHQL_URL = "https://api.cloudflare.com/client/v4/graphql";
export const CLOUDFLARE_REQUEST_TIMEOUT_MS = 10_000;
export const GRAPHQL_ROW_LIMIT = 10_000;

// Analytics can only be queried over a window of at most 31 days.
export const MAX_QUERY_RANGE_DAYS = 31;
// Storage is a time series: we only want the latest measurement per bucket, so
// look back a few days (rows are ordered newest-first before the row limit).
export const STORAGE_LOOKBACK_DAYS = 7;

// Redis.
export const R2_USAGE_CACHE_KEY = "r2:usage:overview";
// Last successful per-account data. No TTL: it is the stale fallback.
export const R2_USAGE_LAST_GOOD_KEY = "r2:usage:last-good";
export const R2_USAGE_LOCK_KEY = "r2:usage:lock";
export const R2_USAGE_CACHE_TTL_SECONDS = 600;
// Shorter TTL when some account failed, so we retry sooner than 10 minutes.
export const R2_USAGE_FAILURE_CACHE_TTL_SECONDS = 60;
export const R2_USAGE_LOCK_TTL_SECONDS = 30;
export const R2_USAGE_LOCK_WAIT_MS = 15_000;
export const R2_USAGE_LOCK_POLL_MS = 250;
