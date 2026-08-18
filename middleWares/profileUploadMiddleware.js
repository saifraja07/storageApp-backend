import multer from "multer";

const MAX_PROFILE_IMAGE_BYTES = 5 * 1024 * 1024; // 5 MB

const storage = multer.memoryStorage();

// Profile images are processed in-memory (via Sharp) and re-encoded to
// WebP before ever touching R2 — they are never written to local disk.
const upload = multer({
    storage,
    limits: {
        fileSize: MAX_PROFILE_IMAGE_BYTES,
        files: 1,
    },
});

// Wraps multer's single-file handler so oversized/malformed uploads return a
// clean JSON error instead of an unhandled 500.
export const profileUpload = (req, res, next) => {
    upload.single("picture")(req, res, (err) => {
        if (!err) return next();

        if (err instanceof multer.MulterError) {
            if (err.code === "LIMIT_FILE_SIZE") {
                return res.status(400).json({
                    error: "Profile image must be 5 MB or smaller.",
                });
            }
            return res.status(400).json({
                error: "Invalid or unsupported image.",
            });
        }

        return res.status(400).json({
            error: "Invalid or unsupported image.",
        });
    });
};
