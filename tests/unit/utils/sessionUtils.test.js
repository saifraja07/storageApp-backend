import { describe, it, expect, vi } from "vitest";
import {
  createSession,
  enforceDeviceLimit,
  deleteUserSessions,
} from "../../../utils/sessionUtils.js";
import { redisMock } from "../../helpers/redisMock.js";

const docs = (...ids) => ({ total: ids.length, documents: ids.map((id) => ({ id })) });

describe("createSession", () => {
  it("stores the session in Redis with a 7 day TTL and sets a secure signed httpOnly cookie", async () => {
    const res = { cookie: vi.fn() };
    await createSession(res, "user-1");

    const [key, path, value] = redisMock.json.set.mock.calls[0];
    expect(key).toMatch(/^session:[0-9a-f-]{36}$/);
    expect(path).toBe("$");
    expect(value).toMatchObject({ userId: "user-1" });
    expect(typeof value.createdAt).toBe("number");
    expect(redisMock.expire).toHaveBeenCalledWith(key, 7 * 24 * 60 * 60);

    const [name, sid, options] = res.cookie.mock.calls[0];
    expect(name).toBe("sid");
    expect(key).toBe(`session:${sid}`);
    expect(options).toEqual({
      httpOnly: true,
      signed: true,
      secure: true,
      sameSite: "lax",
      maxAge: 7 * 24 * 60 * 60 * 1000,
    });
  });

  it("issues a different session id every time", async () => {
    const res = { cookie: vi.fn() };
    await createSession(res, "u");
    await createSession(res, "u");
    expect(res.cookie.mock.calls[0][1]).not.toBe(res.cookie.mock.calls[1][1]);
  });
});

describe("enforceDeviceLimit", () => {
  it("does not evict anything while under the device limit", async () => {
    redisMock.ft.search.mockResolvedValue(docs("session:a"));
    await enforceDeviceLimit("u1", 3);
    expect(redisMock.del).not.toHaveBeenCalled();
  });

  it("makes room for the new login by evicting the oldest session at the limit", async () => {
    redisMock.ft.search.mockResolvedValue(docs("session:old", "session:mid", "session:new"));
    await enforceDeviceLimit("u1", 3);
    expect(redisMock.del).toHaveBeenCalledWith("session:old");
  });

  it("evicts several sessions when the limit was lowered (e.g. after a downgrade)", async () => {
    redisMock.ft.search.mockResolvedValue(docs("session:1", "session:2", "session:3", "session:4"));
    await enforceDeviceLimit("u1", 1);
    expect(redisMock.del).toHaveBeenCalledWith("session:1", "session:2", "session:3", "session:4");
  });

  it("queries sessions oldest-first for the given user", async () => {
    redisMock.ft.search.mockResolvedValue(docs());
    await enforceDeviceLimit("u1", 1);
    expect(redisMock.ft.search).toHaveBeenCalledWith("userIdIdx", "@userId:{u1}", {
      RETURN: [],
      SORTBY: { BY: "createdAt", DIRECTION: "ASC" },
    });
  });

  it("falls back to an unsorted search instead of failing the login", async () => {
    redisMock.ft.search
      .mockRejectedValueOnce(new Error("no such field"))
      .mockResolvedValueOnce(docs("session:a", "session:b"));
    await enforceDeviceLimit("u1", 2);
    expect(redisMock.ft.search).toHaveBeenLastCalledWith("userIdIdx", "@userId:{u1}", { RETURN: [] });
    expect(redisMock.del).toHaveBeenCalledWith("session:a");
  });
});

describe("deleteUserSessions", () => {
  it("deletes every session of the user", async () => {
    redisMock.ft.search.mockResolvedValue(docs("session:a", "session:b"));
    await deleteUserSessions("u1");
    expect(redisMock.del).toHaveBeenCalledWith("session:a", "session:b");
  });

  it("does not call DEL with no keys (Redis would error)", async () => {
    redisMock.ft.search.mockResolvedValue(docs());
    await deleteUserSessions("u1");
    expect(redisMock.del).not.toHaveBeenCalled();
  });
});
