// Shared server-side pagination helpers (admin users + directory contents).

export const PAGE_SIZES = [24, 50, 100];
export const DEFAULT_PAGE = 1;
export const DEFAULT_LIMIT = PAGE_SIZES[0];
export const MAX_SEARCH_LENGTH = 100;

/**
 * Reads `page` / `limit` from a query string. Never throws: a bad page falls
 * back to 1 and a limit outside PAGE_SIZES falls back to the default, so a
 * request can never ask for an arbitrary or huge page size.
 */
export function parsePagination(query) {
  const page = Number.parseInt(query.page, 10);
  const limit = Number.parseInt(query.limit, 10);
  return {
    page: Number.isSafeInteger(page) && page >= 1 ? page : DEFAULT_PAGE,
    limit: PAGE_SIZES.includes(limit) ? limit : DEFAULT_LIMIT,
  };
}

/** Trimmed search text, capped in length; anything that isn't a string is "". */
export function parseSearch(value) {
  return typeof value === "string" ? value.trim().slice(0, MAX_SEARCH_LENGTH) : "";
}

/** Case-insensitive "contains" regex source that treats the text literally. */
export const escapeRegex = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Clamps the requested page into 1..totalPages (an out-of-range page, e.g. after
 * the last item of the last page was deleted, resolves to the last valid page)
 * and builds the metadata object sent to the client.
 */
export function buildPagination({ page, limit, totalItems }) {
  const totalPages = Math.max(1, Math.ceil(totalItems / limit));
  const currentPage = Math.min(page, totalPages);
  return {
    currentPage,
    totalPages,
    totalItems,
    limit,
    hasNextPage: currentPage < totalPages,
    hasPrevPage: currentPage > 1,
  };
}
