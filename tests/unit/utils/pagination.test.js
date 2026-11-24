import { describe, it, expect } from "vitest";
import {
  buildPagination,
  escapeRegex,
  MAX_SEARCH_LENGTH,
  parsePagination,
  parseSearch,
} from "../../../utils/pagination.js";

describe("parsePagination", () => {
  it("defaults to page 1 and 24 per page", () => {
    expect(parsePagination({})).toEqual({ page: 1, limit: 24 });
  });

  it.each([
    ["2", "50", 2, 50],
    ["3", "100", 3, 100],
    ["7", "24", 7, 24],
  ])("accepts page=%s limit=%s", (page, limit, ep, el) => {
    expect(parsePagination({ page, limit })).toEqual({ page: ep, limit: el });
  });

  it.each(["0", "-3", "abc", "", "NaN", "9".repeat(30)])("falls back to page 1 for page=%j", (page) => {
    expect(parsePagination({ page }).page).toBe(1);
  });

  it.each(["0", "-1", "10", "25", "26", "101", "1000000", "abc", ""])(
    "never accepts a page size outside 24/50/100 (limit=%j)",
    (limit) => {
      expect(parsePagination({ limit }).limit).toBe(24);
    },
  );

  it("does not crash on repeated (array) query values", () => {
    expect(parsePagination({ page: ["2", "3"], limit: ["50", "100"] })).toEqual({ page: 2, limit: 50 });
  });
});

describe("parseSearch", () => {
  it("trims, caps the length and ignores non-strings", () => {
    expect(parseSearch("  report ")).toBe("report");
    expect(parseSearch("x".repeat(MAX_SEARCH_LENGTH + 50))).toHaveLength(MAX_SEARCH_LENGTH);
    expect(parseSearch(undefined)).toBe("");
    expect(parseSearch(["a", "b"])).toBe("");
    expect(parseSearch({ $ne: "" })).toBe("");
  });
});

describe("escapeRegex", () => {
  it("makes user text literal inside a RegExp", () => {
    const text = "a.b*c+d?e^f$g(h)i|j[k]l{m}n\\o";
    expect(new RegExp(escapeRegex(text)).test(text)).toBe(true);
    expect(new RegExp(escapeRegex(".*")).test("anything")).toBe(false);
    expect(() => new RegExp(escapeRegex("("))).not.toThrow();
  });
});

describe("buildPagination", () => {
  it("builds the metadata for a middle page", () => {
    expect(buildPagination({ page: 2, limit: 24, totalItems: 87 })).toEqual({
      currentPage: 2, totalPages: 4, totalItems: 87, limit: 24, hasNextPage: true, hasPrevPage: true,
    });
  });

  it.each([
    [0, 1], [1, 1], [10, 1], [24, 1], [25, 2], [48, 2], [49, 3], [101, 5],
  ])("%i items at 24/page → %i page(s)", (totalItems, totalPages) => {
    expect(buildPagination({ page: 1, limit: 24, totalItems }).totalPages).toBe(totalPages);
  });

  it("clamps an out-of-range page to the last page", () => {
    expect(buildPagination({ page: 99, limit: 24, totalItems: 60 })).toMatchObject({
      currentPage: 3, hasNextPage: false, hasPrevPage: true,
    });
  });

  it("an empty result has one page with no neighbours", () => {
    expect(buildPagination({ page: 4, limit: 24, totalItems: 0 })).toEqual({
      currentPage: 1, totalPages: 1, totalItems: 0, limit: 24, hasNextPage: false, hasPrevPage: false,
    });
  });
});
