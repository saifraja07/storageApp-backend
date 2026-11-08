import { describe, it, expect } from "vitest";
import { renameFileSchema } from "../../../validators/fileSchema.js";

describe("renameFileSchema", () => {
  it("accepts and trims a valid name", () => {
    expect(renameFileSchema.parse({ newFilename: "  report.pdf " }).newFilename).toBe("report.pdf");
  });
  it("rejects empty, whitespace-only and over-long names", () => {
    expect(renameFileSchema.safeParse({ newFilename: "" }).success).toBe(false);
    expect(renameFileSchema.safeParse({ newFilename: "   " }).success).toBe(false);
    expect(renameFileSchema.safeParse({ newFilename: "a".repeat(201) }).success).toBe(false);
  });
  it("rejects a missing or non-string name", () => {
    expect(renameFileSchema.safeParse({}).success).toBe(false);
    expect(renameFileSchema.safeParse({ newFilename: 123 }).success).toBe(false);
  });
});
