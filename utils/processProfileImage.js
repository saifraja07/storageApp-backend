import sharp from "sharp";

// HEIC/HEIF files start with an ftyp box whose major/compatible brand names
// one of these — iPhones commonly produce these. Sharp's bundled libvips
// build frequently can't decode HEIC (licensing), so we detect it up front
// and convert to a decodable format first via heic-convert (pure JS).
function looksLikeHeic(buffer) {
  if (!buffer || buffer.length < 12) return false;
  const boxType = buffer.toString("ascii", 4, 8);
  if (boxType !== "ftyp") return false;

  const brand = buffer.toString("ascii", 8, 12);
  const heicBrands = ["heic", "heix", "hevc", "hevx", "heim", "heis", "hevm", "hevs", "mif1", "msf1"];
  return heicBrands.includes(brand);
}

/**
 * Decodes an uploaded image buffer, respects EXIF orientation, and
 * re-encodes it as a normalized 512x512 WebP buffer. The original file is
 * never stored. Throws on any undecodable/invalid input.
 */
export async function processProfileImage(buffer) {
  let sourceBuffer = buffer;

  if (looksLikeHeic(buffer)) {
    const { default: heicConvert } = await import("heic-convert");
    sourceBuffer = Buffer.from(
      await heicConvert({
        buffer,
        format: "JPEG",
        quality: 0.9,
      })
    );
  }

  return sharp(sourceBuffer)
    .rotate()
    .resize(512, 512, { fit: "cover" })
    .webp({ quality: 85 })
    .toBuffer();
}
