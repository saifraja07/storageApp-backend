import { describe, it, expect } from "vitest";
import Directory from "../../../models/directoryModel.js";
import { oid } from "../../helpers/fixtures.js";
import { errorFields } from "../../helpers/validation.js";

describe("Directory model", () => {
  it("accepts a root directory (no parent) and defaults size/path/parent", async () => {
    const dir = new Directory({ name: "root-a@b.co", userId: oid() });
    expect(await errorFields(dir)).toEqual([]);
    expect(dir.size).toBe(0);
    expect(dir.parentDirId).toBeNull();
    expect(Array.from(dir.path)).toEqual([]);
  });

  it("stores the ancestor path for nested directories", async () => {
    const [a, b] = [oid(), oid()];
    const dir = new Directory({ name: "child", userId: oid(), parentDirId: b, path: [a, b] });
    expect(await errorFields(dir)).toEqual([]);
    expect(dir.path.map(String)).toEqual([String(a), String(b)]);
  });

  it("requires a name and an owner", async () => {
    const errors = (await errorFields(new Directory({})));
    expect(errors).toEqual(expect.arrayContaining(["name", "userId"]));
  });

  it("rejects unknown fields (strict: 'throw')", async () => {
    expect(() => new Directory({ name: "x", userId: oid(), hack: 1 })).toThrow();
  });
});
