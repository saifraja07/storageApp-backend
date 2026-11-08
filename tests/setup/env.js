// Runs before every test file (and before any application module is
// imported). Gives the app the environment it needs to load, using dummy
// values only — real secrets are never needed or read by the test suite.
Object.assign(process.env, {
  NODE_ENV: "test",
  PORT: "0",
  CLIENT_URLS: "http://localhost:5173, https://app.example.com",
  COOKIE_SAMESITE: "lax",
  SESSION_SECRET: "test-session-secret",
  OBSERVABILITY_ENABLED: "false",

  DB_URL: "mongodb://127.0.0.1:27017/unused",
  REDIS_URL: "redis://127.0.0.1:6379",

  GOOGLE_CLIENT_ID: "test-google-client-id",
  GOOGLE_CLIENT_SECRET: "test-google-client-secret",
  REDIRECT_URI: "postmessage",

  R2_BUCKET: "test-bucket",
  R2_ENDPOINT: "https://testaccount.r2.cloudflarestorage.com",
  R2_ACCESS_KEY_ID: "test-access-key-id",
  R2_SECRET_ACCESS_KEY: "test-secret-access-key",
  R2_PROFILE_BUCKET_NAME: "test-profile-bucket",
  R2_PROFILE_PUBLIC_URL: "https://cdn.example.com",

  RAZORPAY_KEY_ID: "rzp_test_key",
  RAZORPAY_KEY_SECRET: "rzp_test_secret",
  RAZORPAY_WEBHOOK_SECRET: "rzp_webhook_secret",

  RESEND_KEY: "re_test_key",
});

// Make sure a developer's local .env can never point tests at real services.
delete process.env.PERSONAL_STORAGE_USER_IDS;
delete process.env.PERSONAL_R2_BUCKET;
delete process.env.PERSONAL_R2_ENDPOINT;
delete process.env.PERSONAL_R2_ACCESS_KEY_ID;
delete process.env.PERSONAL_R2_SECRET_ACCESS_KEY;
