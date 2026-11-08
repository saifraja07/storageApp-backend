import { describe, it, expect, vi, beforeEach } from "vitest";
import checkAuth, { requireRole } from "../../../middleWares/authMiddleware.js";
import { redisMock } from "../../helpers/redisMock.js";
import { UserMock } from "../../helpers/modelMocks.js";
import { query } from "../../helpers/query.js";
import { makeUser } from "../../helpers/fixtures.js";

vi.mock("../../../models/userModel.js", async () => ({
  default: (await import("../../helpers/modelMocks.js")).UserMock,
}));

const makeRes = () => ({
  status: vi.fn().mockReturnThis(),
  json: vi.fn(),
  clearCookie: vi.fn(),
});

describe("checkAuth", () => {
  let res;
  let next;
  beforeEach(() => {
    res = makeRes();
    next = vi.fn();
  });

  it("returns 401 and clears the cookie when there is no sid cookie", async () => {
    await checkAuth({ signedCookies: {} }, res, next);
    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.clearCookie).toHaveBeenCalledWith("sid");
    expect(next).not.toHaveBeenCalled();
    expect(redisMock.json.get).not.toHaveBeenCalled();
  });

  it("returns 401 when the session is not in Redis (expired / logged out)", async () => {
    redisMock.json.get.mockResolvedValue(null);
    await checkAuth({ signedCookies: { sid: "abc" } }, res, next);
    expect(redisMock.json.get).toHaveBeenCalledWith("session:abc");
    expect(res.status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });

  it("returns 401 when the session's user no longer exists", async () => {
    redisMock.json.get.mockResolvedValue({ userId: "u1" });
    UserMock.findById.mockReturnValue(query(null));
    await checkAuth({ signedCookies: { sid: "abc" } }, res, next);
    expect(res.status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });

  it("returns 403 for a soft-deleted (disabled) account", async () => {
    redisMock.json.get.mockResolvedValue({ userId: "u1" });
    UserMock.findById.mockReturnValue(query(makeUser({ isDeleted: true })));
    await checkAuth({ signedCookies: { sid: "abc" } }, res, next);
    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith({
      error: "Your account is disabled! Contact Admin to recover.",
    });
    expect(next).not.toHaveBeenCalled();
  });

  it("attaches the user to the request and calls next() for a valid session", async () => {
    const user = makeUser();
    redisMock.json.get.mockResolvedValue({ userId: user._id });
    UserMock.findById.mockReturnValue(query(user));
    const req = { signedCookies: { sid: "abc" } };
    await checkAuth(req, res, next);
    expect(UserMock.findById).toHaveBeenCalledWith(user._id);
    expect(req.user).toBe(user);
    expect(next).toHaveBeenCalledTimes(1);
    expect(res.status).not.toHaveBeenCalled();
  });
});

describe("requireRole", () => {
  const run = (userRole, minRole) => {
    const res = makeRes();
    const next = vi.fn();
    requireRole(minRole)({ user: { role: userRole } }, res, next);
    return { res, next };
  };

  it.each([
    ["User", "User"],
    ["Manager", "Manager"],
    ["Admin", "Manager"],
    ["SuperAdmin", "Admin"],
  ])("allows %s when %s is required", (userRole, minRole) => {
    const { next, res } = run(userRole, minRole);
    expect(next).toHaveBeenCalledTimes(1);
    expect(res.status).not.toHaveBeenCalled();
  });

  it.each([
    ["User", "Manager"],
    ["Manager", "Admin"],
    ["Admin", "SuperAdmin"],
    ["Unknown", "User"],
  ])("denies %s when %s is required", (userRole, minRole) => {
    const { next, res } = run(userRole, minRole);
    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith({ error: "Access denied!" });
  });
});
