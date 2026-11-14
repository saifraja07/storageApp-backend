import z from "zod";

export const renameFileSchema = z.object({
    newFilename: z.string()
        .trim()
        .min(1, "File name required")
        .max(200, "File name is too long")
});

// Control characters (newlines, NUL, ...) have no place in a file name.
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

const objectId = z.string().regex(/^[0-9a-fA-F]{24}$/, "Invalid parent directory id");

export const uploadInitiateSchema = z.object({
    // Raw file name exactly as the browser reports it (NOT URI-encoded).
    // A "/" is tolerated here because the controller keeps only the basename.
    name: z
        .string()
        .min(1, "File name required")
        .max(255, "File name is too long")
        .refine((v) => !CONTROL_CHARS.test(v), "Name contains invalid characters")
        .optional(),
    size: z.coerce
        .number({ error: "Invalid filesize!" })
        .finite("Invalid filesize!")
        .int("Invalid filesize!")
        .min(0, "Invalid filesize!"),
    parentDirId: z.union([objectId, z.literal("")]).nullish(),
    contentType: z.string().max(255).optional(),
});
