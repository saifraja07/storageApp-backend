import { vi } from "vitest";
// Mimics a Mongoose Query: chainable (.lean/.select/.sort/…) and awaitable.
export function query(result) {
  const q = {
    lean: () => q,
    select: () => q,
    sort: () => q,
    populate: () => q,
    limit: () => q,
    session: () => q,
    then: (resolve, reject) => Promise.resolve(result).then(resolve, reject),
    catch: (reject) => Promise.resolve(result).catch(reject),
  };
  return q;
}

/**
 * Like `query`, but every chain method is a vi.fn() so a test can assert on the
 * sort / skip / limit / collation / filter the controller built.
 */
export function spyQuery(result) {
  const q = { then: (resolve, reject) => Promise.resolve(result).then(resolve, reject) };
  for (const method of ["lean", "select", "sort", "skip", "limit", "collation"]) {
    q[method] = vi.fn(() => q);
  }
  return q;
}
