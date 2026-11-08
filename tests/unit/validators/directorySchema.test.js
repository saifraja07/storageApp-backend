import { describe, it, expect } from "vitest";
import {
  createDirectorySchema,
  renameDirectorySchema,
} from "../../../validators/directorySchema.js";

describe("createDirectorySchema", () => {
  it("allows omitting the name (controller falls back to 'New Folder')", () => {
    expect(createDirectorySchema.safeParse({}).success).toBe(true);
  });
  it("trims the name", () => {
    expect(createDirectorySchema.parse({ dirname: "  Photos  " }).dirname).toBe("Photos");
  });
  it("rejects blank and over-long names", () => {
    expect(createDirectorySchema.safeParse({ dirname: "   " }).success).toBe(false);
    expect(createDirectorySchema.safeParse({ dirname: "a".repeat(201) }).success).toBe(false);
    expect(createDirectorySchema.safeParse({ dirname: "a".repeat(200) }).success).toBe(true);
  });
});

describe("renameDirectorySchema", () => {
  it("requires newDirName", () => {
    expect(renameDirectorySchema.safeParse({}).success).toBe(false);
    const r = renameDirectorySchema.safeParse({ newDirName: "" });
    expect(r.error.issues[0].message).toBe("Directory name required");
  });
  it("accepts a valid name", () => {
    expect(renameDirectorySchema.parse({ newDirName: " Docs " }).newDirName).toBe("Docs");
  });
});
