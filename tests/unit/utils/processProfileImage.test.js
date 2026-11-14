import { describe, it, expect } from "vitest";
import sharp from "sharp";
import { processProfileImage } from "../../../utils/processProfileImage.js";

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

  it("sends HEIC-looking files to the worker thread and rejects fake ones without crashing", async () => {
    // minimal ISO-BMFF header: 4 byte size, "ftyp", "heic" brand, but no real image data
    const fakeHeic = Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from("ftypheic"), Buffer.alloc(16)]);
    await expect(processProfileImage(fakeHeic)).rejects.toThrow();
  });

  it("rejects an image above the pixel limit (decompression bomb)", async () => {
    // ~81 megapixels but only a few KB on disk
    const bomb = await sharp({ create: { width: 9000, height: 9000, channels: 3, background: { r: 128, g: 128, b: 128 } } })
      .png({ compressionLevel: 9 })
      .toBuffer();
    expect(bomb.length).toBeLessThan(5 * 1024 * 1024);
    await expect(processProfileImage(bomb)).rejects.toThrow(/pixel/i);
  });

  it("accepts AVIF pictures (sharp reports AVIF as \"heif\")", async () => {
    const avif = await sharp({ create: { width: 64, height: 64, channels: 3, background: "#08f" } }).avif().toBuffer();
    expect((await sharp(avif).metadata()).format).toBe("heif"); // documents why "heif" is allowed
    const out = await processProfileImage(avif);
    const meta = await sharp(out).metadata();
    expect(meta.format).toBe("webp");
    expect([meta.width, meta.height]).toEqual([512, 512]);
  });

  it("rejects formats that are not plain photos (e.g. SVG)", async () => {
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="10" height="10"/></svg>');
    await expect(processProfileImage(svg)).rejects.toThrow(/Unsupported image format/);
  });

  it("accepts a phone-sized photo (12 MP)", async () => {
    const out = await processProfileImage(await makeImage(4000, 3000, "jpeg"));
    expect((await sharp(out).metadata()).format).toBe("webp");
  });
});
