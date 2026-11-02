// Decides which Cloudflare R2 account a user's files live in.
//
// Production R2 is the default for everyone. Only the MongoDB user IDs listed
// in PERSONAL_STORAGE_USER_IDS (comma-separated) use the personal R2 account.
//
// The decision is made purely in memory from a trusted server-side ID
// (req.user._id, a target user's _id, or a File document's userId).

const parseIds = (raw) =>
  new Set(
    String(raw ?? "")
      .split(",")
      .map((id) => id.trim().toLowerCase())
      .filter(Boolean)
  );

// Parsed once at module load and reused for every call.
const personalUserIds = parseIds(process.env.PERSONAL_STORAGE_USER_IDS);

// A typo, stray quote or wrong value would never match any user, silently
// leaving that user on production storage. Surface it at startup (log only —
// never throw, so a bad value can't take production down).
const malformedCount = [...personalUserIds].filter(
  (id) => !/^[0-9a-f]{24}$/.test(id)
).length;
if (malformedCount > 0) {
  console.warn(
    `[storage] PERSONAL_STORAGE_USER_IDS contains ${malformedCount} entr${malformedCount === 1 ? "y" : "ies"} that ${malformedCount === 1 ? "is" : "are"} not a 24-character hex MongoDB ObjectId; ${malformedCount === 1 ? "it" : "they"} will never match a user.`
  );
}

// Accepts an ObjectId or a string. String() on an ObjectId yields its hex form.
export const isPersonalStorageUser = (userId) => {
  if (userId === undefined || userId === null) return false;
  return personalUserIds.has(String(userId).toLowerCase());
};
