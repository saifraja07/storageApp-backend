import { describe, it, expect, vi } from "vitest";
import { getTargetUser } from "../../../utils/getTargetUser.js";
import { UserMock } from "../../helpers/modelMocks.js";
import { makeUser } from "../../helpers/fixtures.js";

vi.mock("../../../models/userModel.js", async () => ({
  default: (await import("../../helpers/modelMocks.js")).UserMock,
}));

const makeRes = () => ({ status: vi.fn().mockReturnThis(), json: vi.fn() });

async function run(actor, target) {
  UserMock.findById.mockResolvedValue(target);
  const res = makeRes();
  const result = await getTargetUser({ user: actor, params: { userId: "t" } }, res);
  return { result, res };
}

describe("getTargetUser", () => {
  it("responds 404 and returns null when the target does not exist", async () => {
    const { result, res } = await run(makeUser({ role: "Admin" }), null);
    expect(result).toBeNull();
    expect(res.status).toHaveBeenCalledWith(404);
    expect(res.json).toHaveBeenCalledWith({ error: "User not found" });
  });

  it("returns the target when the actor outranks them", async () => {
    const target = makeUser({ role: "User" });
    const { result, res } = await run(makeUser({ role: "Manager" }), target);
    expect(result).toBe(target);
    expect(res.status).not.toHaveBeenCalled();
  });

  it("responds 403 when the target has the same or a higher role", async () => {
    for (const targetRole of ["Admin", "SuperAdmin"]) {
      const { result, res } = await run(makeUser({ role: "Admin" }), makeUser({ role: targetRole }));
      expect(result).toBeNull();
      expect(res.status).toHaveBeenCalledWith(403);
    }
  });

  it("always lets a user act on themselves", async () => {
    const me = makeUser({ role: "User" });
    const { result } = await run(me, { ...me });
    expect(result).toEqual(me);
  });
});
