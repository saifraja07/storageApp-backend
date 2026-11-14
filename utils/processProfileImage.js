import { Worker, isMainThread, parentPort, workerData } from "node:worker_threads";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

// ---------------------------------------------------------------------------
// HEIC conversion runs in a worker thread (this same file is the worker).
// heic-convert is pure JS/WASM and CPU-heavy: on the main thread it would freeze
// every other request while it runs. The worker has a memory cap and a timeout
// and is simply killed if a hostile file makes it misbehave.
// ---------------------------------------------------------------------------

// Worker side: only runs when this file is started as a worker for a HEIC job.
if (!isMainThread && workerData?.heicJob) {
  (async () => {
    try {
      const { default: heicConvert } = await import("heic-convert");
      const out = await heicConvert({
        buffer: Buffer.from(workerData.buffer),
        format: "JPEG",
        quality: 0.9,
      });
      parentPort.postMessage({ ok: true, data: Buffer.from(out) });
    } catch (err) {
      parentPort.postMessage({ ok: false, error: err?.message ?? String(err) });
    }
  })();
}

/** Converts a HEIC/HEIF buffer to JPEG inside a capped, time-limited worker thread. */
function convertHeicToJpeg(buffer, { timeoutMs = 20_000 } = {}) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(fileURLToPath(import.meta.url), {
      workerData: { heicJob: true, buffer },
      resourceLimits: { maxOldGenerationSizeMb: 256 },
    });

    const timer = setTimeout(() => {
      worker.terminate();
      reject(new Error("HEIC conversion timed out"));
    }, timeoutMs);

    const done = (fn, value) => {
      clearTimeout(timer);
      worker.terminate();
      fn(value);
    };

    worker.once("message", (msg) =>
      msg.ok
        ? done(resolve, Buffer.from(msg.data))
        : done(reject, new Error(msg.error || "HEIC conversion failed"))
    );
    worker.once("error", (err) => done(reject, err));
    worker.once("exit", (code) => {
      if (code !== 0) done(reject, new Error(`HEIC worker exited with code ${code}`));
    });
  });
}

// Decoded size = width x height x channels, no matter how small the file is on
// disk. sharp's default ceiling (~268 megapixels) would let a tiny 5 MB file
// expand to hundreds of MB of RAM. 64 MP (8000x8000) still covers every phone
// camera (12-50 MP) while keeping decompression bombs out.
const MAX_INPUT_PIXELS = 64_000_000;

// Only real photo formats. Anything else sharp *can* open (SVG, PDF, TIFF,
// raw...) is refused for a profile picture.
// NOTE: sharp reports AVIF files as "heif" (never "avif"), so "heif" must be
// allowed or AVIF pictures are rejected. Real HEIC photos never get here as
// "heif": they are converted to JPEG above.
const ALLOWED_FORMATS = new Set(["jpeg", "png", "webp", "gif", "heif"]);

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
    sourceBuffer = await convertHeicToJpeg(buffer);
  }

  const image = sharp(sourceBuffer, { limitInputPixels: MAX_INPUT_PIXELS });

  // Header-only read: rejects over-limit images and unknown formats before any
  // real decoding work happens.
  const { format } = await image.metadata();
  if (!ALLOWED_FORMATS.has(format)) {
    throw new Error(`Unsupported image format: ${format}`);
  }

  return image
    .rotate()
    .resize(512, 512, { fit: "cover" })
    .webp({ quality: 85 })
    .toBuffer();
}
