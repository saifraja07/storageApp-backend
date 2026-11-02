import { DeleteObjectCommand, DeleteObjectsCommand, GetObjectCommand, HeadObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { isPersonalStorageUser } from "./storageResolver.js";

const bucketName = process.env.R2_BUCKET
const profileBucketName = process.env.R2_PROFILE_BUCKET_NAME
const profilePublicUrl = process.env.R2_PROFILE_PUBLIC_URL

export const r2Client = new S3Client({
    region: "auto",
    endpoint: process.env.R2_ENDPOINT,
    credentials: {
        accessKeyId: process.env.R2_ACCESS_KEY_ID,
        secretAccessKey: process.env.R2_SECRET_ACCESS_KEY
    }
})

// ---------------------------------------------------------------------------
// Personal R2 account — used ONLY for user IDs listed in PERSONAL_STORAGE_USER_IDS
// (see storageResolver.js). Created once at module load and reused. If any of
// the four PERSONAL_R2_* variables is missing the client is not created, and
// getStorage() refuses to serve a personal user instead of silently falling
// back to the production bucket.
// ---------------------------------------------------------------------------

const personalBucketName = process.env.PERSONAL_R2_BUCKET

const personalR2Configured = Boolean(
    process.env.PERSONAL_R2_BUCKET &&
    process.env.PERSONAL_R2_ENDPOINT &&
    process.env.PERSONAL_R2_ACCESS_KEY_ID &&
    process.env.PERSONAL_R2_SECRET_ACCESS_KEY
)

export const personalR2Client = personalR2Configured
    ? new S3Client({
        region: "auto",
        endpoint: process.env.PERSONAL_R2_ENDPOINT,
        credentials: {
            accessKeyId: process.env.PERSONAL_R2_ACCESS_KEY_ID,
            secretAccessKey: process.env.PERSONAL_R2_SECRET_ACCESS_KEY
        }
    })
    : null

// Picks the client + bucket for the user who OWNS the file. Production is the
// default. A missing userId throws, so a call site that forgets to pass it can
// never silently use the production bucket for a personal user's files.
const getStorage = (userId) => {
    if (userId === undefined || userId === null || userId === "") {
        throw new Error("R2 storage selection requires the file owner's userId")
    }

    if (!isPersonalStorageUser(userId)) {
        return { client: r2Client, bucket: bucketName }
    }

    if (!personalR2Client) {
        throw new Error("Personal R2 storage is not fully configured")
    }

    return { client: personalR2Client, bucket: personalBucketName }
}

export const createUploadSignedUrl = async ({ key, contentType, userId }) => {
    const { client, bucket } = getStorage(userId)

    const command = new PutObjectCommand({
        Bucket: bucket,
        Key: key,
        ContentType: contentType
    })

    const url = await getSignedUrl(client, command, {
        expiresIn: 300,
        signableHeaders: new Set(["content-type"])
    })

    return url;
}

export const createGetSignedUrl = async ({ key, download = false, filename, userId }) => {
    const { client, bucket } = getStorage(userId)

    const command = new GetObjectCommand({
        Bucket: bucket,
        Key: key,
        ResponseContentDisposition: `${download ? "attachment" : "inline"}; filename="${filename}"; filename*=UTF-8''${encodeURIComponent(filename)}`
    })

    const url = await getSignedUrl(client, command, {
        expiresIn: 3600,
    })
    return url;
}

export const deleteR2File = async ({ key, userId }) => {
    const { client, bucket } = getStorage(userId)

    const command = new DeleteObjectCommand({
        Bucket: bucket,
        Key: key,
    })
    return await client.send(command);
}

export const deleteR2Files = async (keys, userId) => {
    const { client, bucket } = getStorage(userId)

    const command = new DeleteObjectsCommand({
        Bucket: bucket,
        Delete: {
            Objects: keys,
            Quiet: true
        }
    })

    return await client.send(command);
}

export const getR2FileMetaData = async ({ key, userId }) => {
    const { client, bucket } = getStorage(userId)

    const command = new HeadObjectCommand({
        Bucket: bucket,
        Key: key,
    })
    return await client.send(command);
}

// ---------------------------------------------------------------------------
// Profile image helpers — these ALWAYS target the dedicated public profile
// bucket (R2_PROFILE_BUCKET_NAME), never the private storage bucket above.
// The profile bucket lives in the PRODUCTION R2 account for every user, so these
// intentionally use r2Client directly and never go through getStorage().
// ---------------------------------------------------------------------------

export const uploadProfilePicture = async ({ key, body, contentType = "image/webp" }) => {
    const command = new PutObjectCommand({
        Bucket: profileBucketName,
        Key: key,
        Body: body,
        ContentType: contentType,
        CacheControl: "public, max-age=31536000, immutable",
    })
    return await r2Client.send(command);
}

export const deleteProfilePicture = async ({ key }) => {
    const command = new DeleteObjectCommand({
        Bucket: profileBucketName,
        Key: key,
    })
    return await r2Client.send(command);
}

// Safely combines the public CDN base URL with an object key, avoiding
// double slashes. Never hardcode the CDN domain — it always comes from env.
export const getProfilePictureURL = (key) => {
    const base = profilePublicUrl.replace(/\/+$/, "");
    const cleanKey = key.replace(/^\/+/, "");
    return `${base}/${cleanKey}`;
}

// Given a full CDN URL, returns the R2 object key if — and only if — the URL
// actually belongs to our profile CDN domain. Returns null otherwise.
export const getProfilePictureKeyFromURL = (url) => {
    if (!url || typeof url !== "string") return null;

    let parsed;
    try {
        parsed = new URL(url);
    } catch {
        return null;
    }

    let base;
    try {
        base = new URL(profilePublicUrl);
    } catch {
        return null;
    }

    if (parsed.origin !== base.origin) return null;

    const key = parsed.pathname.replace(/^\/+/, "");
    if (!key) return null;

    return key;
}

// Verifies a picture URL is BOTH hosted on our profile CDN AND scoped to the
// given user's own profile-image namespace, before it's ever safe to delete.
// The client-supplied userId must never be trusted here — always pass the
// authenticated/target user's own id (from the DB), never from a request body.
export const isOwnedProfilePictureURL = (pictureUrl, userId) => {
    const key = getProfilePictureKeyFromURL(pictureUrl);
    if (!key) return false;

    const expectedPrefix = `profile-pictures/${userId}/`;
    if (!key.startsWith(expectedPrefix)) return false;

    // Reject path traversal / unsafe key characters defensively.
    if (key.includes("..") || key.includes("\\")) return false;

    return true;
}
