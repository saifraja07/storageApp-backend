import { describe, it, expect } from "vitest";
import File from "../../../models/fileModel.js";
import { oid } from "../../helpers/fixtures.js";
import { errorFields } from "../../helpers/validation.js";

const validData = () => ({
  name: "report.pdf",
  extension: ".pdf",
  size: 1024,
  userId: oid(),
  parentDirId: oid(),
  isUploading: true,
});

describe("File model", () => {
  it("accepts a valid file", async () => {
    expect(await errorFields(new File(validData()))).toEqual([]);
  });

  it.each(["name", "extension", "size", "userId", "parentDirId", "isUploading"])(
    "requires %s",
    async (field) => {
      const data = validData();
      delete data[field];
      expect((await errorFields(new File(data)))).toContain(field);
    },
  );

  it("treats an empty extension as missing (files without extension need handling upstream)", async () => {
    expect((await errorFields(new File({ ...validData(), extension: "" })))).toContain("extension");
  });

  it("rejects unknown fields (strict: 'throw')", async () => {
    expect(() => new File({ ...validData(), path: "/etc" })).toThrow();
  });

  it("rejects non-numeric sizes", async () => {
    expect((await errorFields(new File({ ...validData(), size: "big" })))).toContain("size");
  });
});
