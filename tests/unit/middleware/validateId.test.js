import { describe, it, expect, vi } from "vitest";
import validateId from "../../../middleWares/validateIdMiddleware.js";

function run(id) {
  const res = { status: vi.fn().mockReturnThis(), json: vi.fn() };
  const next = vi.fn();
  validateId({}, res, next, id);
  return { res, next };
}

describe("validateIdMiddleware", () => {
  it("calls next() for a valid ObjectId", () => {
    const { res, next } = run("507f1f77bcf86cd799439011");
    expect(next).toHaveBeenCalledTimes(1);
    expect(res.status).not.toHaveBeenCalled();
  });

  it.each(["123", "not-an-id", "{$ne:1}", "../etc/passwd", "507f1f77bcf86cd79943901Z"])(
    "rejects %s with 400",
    (bad) => {
      const { res, next } = run(bad);
      expect(next).not.toHaveBeenCalled();
      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith({ error: `Invalid Id! ${bad}` });
    },
  );
});
