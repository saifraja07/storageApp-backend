import { describe, it, expect, vi } from "vitest";
import { sanitizeInputs } from "../../../middleWares/sanitizeMiddleware.js";

function run(fields, body) {
  const req = { body };
  const next = vi.fn();
  sanitizeInputs(fields)(req, {}, next);
  return { req, next };
}

describe("sanitizeInputs", () => {
  it("leaves plain text alone and trims it", () => {
    const { req, next } = run(["name"], { name: "  My Folder  " });
    expect(req.body.name).toBe("My Folder");
    expect(next).toHaveBeenCalledWith();
  });

  it("strips HTML tags but keeps their text", () => {
    const { req } = run(["name"], { name: "<b>Bold</b> <i>name</i>" });
    expect(req.body.name).toBe("Bold name");
  });

  it.each([
    "<script>alert(1)</script>",
    "<img src=x onerror=alert(1)>",
    "<a href=\"javascript:alert(1)\">click</a>",
    "<svg/onload=alert(1)>",
  ])("removes executable markup from %s", (payload) => {
    const { req } = run(["name"], { name: payload });
    expect(req.body.name).not.toMatch(/[<>]/);
    expect(req.body.name).not.toMatch(/onerror|onload|javascript:/i);
    expect(req.body.name).not.toContain("alert(1)");
  });

  it("only touches the listed fields", () => {
    const { req } = run(["name"], { name: "<b>x</b>", other: "<b>y</b>" });
    expect(req.body.name).toBe("x");
    expect(req.body.other).toBe("<b>y</b>");
  });

  it("ignores non-string values and missing fields", () => {
    const { req, next } = run(["a", "b", "c"], { a: 42, b: { nested: "<b>x</b>" } });
    expect(req.body).toEqual({ a: 42, b: { nested: "<b>x</b>" } });
    expect(next).toHaveBeenCalledWith();
  });

  it("works with no configured fields", () => {
    const { req, next } = run(undefined, { name: "<b>x</b>" });
    expect(req.body.name).toBe("<b>x</b>");
    expect(next).toHaveBeenCalledTimes(1);
  });
});
