import { createClient, SCHEMA_FIELD_TYPE } from "redis";

// One-time Redis setup (run before first start): creates the session search index
// used by the device limit, logout-all and the admin "logged in" flag.
// Needs Redis Stack (RedisJSON + RediSearch). Safe to re-run: does nothing if it exists.
const SESSION_INDEX = "userIdIdx";

const redisClient = createClient({ url: process.env.REDIS_URL });
redisClient.on("error", (err) => console.log("Redis Client Error", err));
await redisClient.connect();

try {
  await redisClient.ft.create(
    SESSION_INDEX,
    {
      "$.userId": { type: SCHEMA_FIELD_TYPE.TAG, AS: "userId" },
      "$.createdAt": { type: SCHEMA_FIELD_TYPE.NUMERIC, AS: "createdAt", SORTABLE: true },
    },
    { ON: "JSON", PREFIX: "session:" },
  );
  console.log(`Created Redis search index "${SESSION_INDEX}".`);
} catch (err) {
  if (/already exists/i.test(err?.message ?? "")) {
    console.log(`Redis search index "${SESSION_INDEX}" already exists — nothing to do.`);
  } else {
    console.error("Error setting up Redis (is this Redis Stack with RediSearch + RedisJSON?):", err);
    process.exitCode = 1;
  }
} finally {
  await redisClient.quit();
}