import { describe, it, expect, vi } from "vitest";
import sharp from "sharp";
import { processProfileImage } from "../../../utils/processProfileImage.js";

const { heicConvert } = vi.hoisted(() => ({ heicConvert: vi.fn() }));
vi.mock("heic-convert", () => ({ default: heicConvert }));

const makeImage = (width, height, format = "png") =>
  sharp({ create: { width, height, channels: 3, background: { r: 200, g: 30, b: 30 } } })
    [format]()
    .toBuffer();

describe("processProfileImage", () => {
  it("re-encodes any image as a 512x512 WebP", async () => {
    const out = await processProfileImage(await makeImage(1200, 600));
    const meta = await sharp(out).metadata();
    expect(meta.format).toBe("webp");
    expect(meta.width).toBe(512);
    expect(meta.height).toBe(512);
  });

  it("also upscales small images to 512x512", async () => {
    const out = await processProfileImage(await makeImage(40, 40, "jpeg"));
    const meta = await sharp(out).metadata();
    expect([meta.width, meta.height]).toEqual([512, 512]);
  });

  it("rejects data that is not an image", async () => {
    await expect(processProfileImage(Buffer.from("definitely not an image"))).rejects.toThrow();
  });

  it("converts HEIC/HEIF photos through heic-convert first", async () => {
    const jpeg = await makeImage(300, 200, "jpeg");
    heicConvert.mockResolvedValue(jpeg);
    // minimal ISO-BMFF header: 4 byte size, "ftyp", "heic" brand
    const heicLike = Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from("ftypheic"), Buffer.alloc(16)]);

    const out = await processProfileImage(heicLike);

    expect(heicConvert).toHaveBeenCalledWith(expect.objectContaining({ buffer: heicLike, format: "JPEG" }));
    expect((await sharp(out).metadata()).format).toBe("webp");
  });

  it("does not use heic-convert for ordinary images", async () => {
    await processProfileImage(await makeImage(64, 64));
    expect(heicConvert).not.toHaveBeenCalled();
  });
});
