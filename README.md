# Haadi Cloud — Backend

The API server for Haadi Cloud, a cloud storage platform. Built with Express 5 and MongoDB (Mongoose), it handles authentication, file/directory management with direct-to-storage uploads, Razorpay subscriptions, and role-based admin operations.

## Tech Stack

- **Node.js** (ESM) + **Express 5** — HTTP server and routing
- **MongoDB** + **Mongoose** — primary data store
- **Redis** — session storage (via `redis` client, JSON module)
- **Cloudflare R2** (`@aws-sdk/client-s3`, S3-compatible API) — file storage, with presigned URLs for direct client uploads; a second, dedicated public R2 bucket + Cloudflare CDN domain serves profile images
- **multer** + **sharp** (+ **heic-convert** for iPhone HEIC/HEIF uploads) — profile picture upload handling and normalization to WebP
- **Google Auth Library** — Google OAuth login
- **Razorpay** — subscription billing, checkout, and webhooks
- **Resend** — transactional email (OTP delivery)
- **bcrypt** — password hashing
- **zod** — request validation schemas
- **helmet**, **cors**, **express-rate-limit** — security and rate limiting
- **dompurify** + **jsdom** — server-side input sanitization

## Project Structure

```
.
├── app.js                     # Entry point: middleware, routes, cron jobs
├── config/
│   ├── db.js                  # MongoDB connection
│   ├── redis.js                # Redis client
│   ├── plans.js                # Subscription plan definitions (storage/device limits, pricing)
│   └── setup.js                # One-off script: applies MongoDB JSON-schema validators
├── controllers/                # Request handlers, one per resource
│   ├── authController.js       # OTP + Google OAuth login
│   ├── userController.js       # Register, login, logout, password, self-delete
│   ├── directoryController.js
│   ├── fileController.js       # Upload lifecycle, rename, delete
│   ├── subscriptionController.js
│   ├── webhookController.js    # Razorpay webhook handling
│   └── adminController.js      # User/role management for admins
├── middleWares/
│   ├── authMiddleware.js       # Session check (checkAuth) + role gate (requireRole)
│   ├── limiterMiddleware.js    # Rate limiting + request throttling
│   ├── sanitizeMiddleware.js    # Strips unsafe HTML/script content from named fields
│   └── validateIdMiddleware.js # Validates Mongo ObjectId route params
├── models/                     # Mongoose schemas: User, Directory, File, Otp, Session, Subscription, WebhookEvent
├── routes/                     # Express routers, one per resource
├── services/
│   ├── cloudflareR2Service.js   # S3-compatible client + presigned URL helpers
│   ├── googleAuthService.js     # Google token verification
│   └── sendOtpService.js        # Email OTP delivery via Resend
├── jobs/
│   └── subscriptionCron.js      # Daily job to expire lapsed subscriptions
├── utils/                      # roles/permissions, session helpers, directory-tree math, cleanup, etc.
└── validators/                 # zod schemas per resource
```

## Features

- **Authentication**
  - Email/password registration and login (bcrypt-hashed passwords)
  - Email OTP verification via Resend, with strict rate limiting and throttling on send/verify endpoints
  - Google OAuth sign-in
  - Server-side sessions stored in Redis, keyed by a signed `sid` cookie; `checkAuth` middleware resolves the session to a user on every protected request
  - Logout from current session or all sessions (`logout-all`)
- **File & directory management**
  - Directory tree operations: create, rename, delete, read contents, resolve full path
  - Direct-to-storage file uploads against Cloudflare R2 using presigned URLs, with a three-step lifecycle: `initiate` → client uploads directly to R2 → `complete` (or `cancel`)
  - File rename/delete, with input sanitization on user-supplied names
  - Bulk delete across files/directories
  - A background job (`cleanupUploads`, hourly) removes stale/incomplete uploads
- **Storage limits & plans**
  - Per-user storage quota and device limit enforced against `config/plans.js` (`FREE_PLAN` and per-Razorpay-plan `PLAN_CONFIG`)
  - `usedStorageInBytes` / `reservedStorage` tracked on the user document
- **Subscriptions & billing (Razorpay)**
  - Create subscription, verify checkout signature, fetch active subscription, cancel, update payment method link, payment history
  - A dedicated `/webhook/razorpay` route (raw-body + HMAC signature verification) processes async billing events independent of user-facing verification
  - Daily cron (`subscriptionCron.js`) expires subscriptions whose billing period has lapsed
- **Role-based admin panel**
  - Roles ranked by level: `User` (1) < `Manager` (2) < `Admin` (3) < `SuperAdmin` (4), enforced via `requireRole(minRole)` and `canManageUser`/`canAssignRole` helpers so an actor can only act on strictly lower-ranked roles
  - Manager+: list all users, view plans/subscriptions dashboard, force-logout a user
  - Admin+: soft-delete/recover a user, change a user's role
  - SuperAdmin only: hard-delete a user
- **Security**
  - `helmet` for HTTP security headers, `cors` restricted to a configurable allow-list (`CLIENT_URLS`)
  - Per-route rate limiting and progressive request throttling on sensitive endpoints (login, register, OTP, uploads, subscription actions)
  - Signed cookies for session IDs; sanitization middleware on free-text inputs (directory/file names)
  - MongoDB collection-level JSON-schema validators (applied via `npm run setup`) as a defense-in-depth layer against malformed documents

## API Overview

All routes are mounted in `app.js`. Most are prefixed as shown; `userRoutes` and `authRoutes` are mounted at root/`/auth` and contain their own `/user/...` paths.

| Mount | Router | Auth required |
|---|---|---|
| `/webhook` | `webhookRoutes` | Signature-verified, not session-based |
| `/` | `userRoutes` (`/user/register`, `/user/login`, `/user/logout`, `/user/logout-all`, `/user`, `/user/change-password`, `/user/update-profile`, `/user/soft-delete`, `/user/hard-delete`, `/user/bulk-delete`) | Mixed — login/register public, rest require session |
| `/auth` | `authRoutes` (`/send-otp`, `/verify-otp`, `/google`) | Public, rate-limited |
| `/file` | `fileRoutes` | Session required |
| `/directory` | `directoryRoutes` | Session required |
| `/subscription` | `subscriptionRoutes` | Session required |
| `/admin` | `adminRoutes` | Session + role required (`Manager`/`Admin`/`SuperAdmin` depending on route) |

A catch-all error handler returns a generic 500 JSON response and logs the full error server-side.

## Getting Started

### Prerequisites

- Node.js (LTS recommended)
- A MongoDB instance
- A Redis instance
- A Cloudflare R2 bucket (or other S3-compatible storage)
- Accounts/API keys for: Google OAuth, Razorpay, Resend

### Installation

```bash
git clone <repository-url>
cd storageApp-backend
npm install
```

### Environment Variables

Create a `.env` file in the project root:

```env
# Server
PORT=4000
CLIENT_URLS=http://localhost:5173,https://yourapp.com   # comma-separated allow-list for CORS
SESSION_SECRET=your-cookie-signing-secret
COOKIE_SAMESITE=lax

# MongoDB / Redis
DB_URL=mongodb://localhost:27017/haadi-cloud
REDIS_URL=redis://localhost:6379

# Google OAuth
GOOGLE_CLIENT_ID=your-google-client-id
GOOGLE_CLIENT_SECRET=your-google-client-secret
REDIRECT_URI=http://localhost:5173/auth/google/callback

# Cloudflare R2 — PRIVATE bucket (existing user files, stays private)
R2_BUCKET=your-bucket-name
R2_ENDPOINT=https://<account-id>.r2.cloudflarestorage.com
R2_ACCESS_KEY_ID=your-r2-access-key-id
R2_SECRET_ACCESS_KEY=your-r2-secret-access-key

# Cloudflare R2 — PUBLIC profile-image bucket (separate bucket + CDN domain)
R2_PROFILE_BUCKET_NAME=your-profile-picture-bucket-name
R2_PROFILE_PUBLIC_URL=your-custom-domain-bucket-url

# Razorpay
RAZORPAY_KEY_ID=your-razorpay-key-id
RAZORPAY_KEY_SECRET=your-razorpay-key-secret
RAZORPAY_WEBHOOK_SECRET=your-razorpay-webhook-secret

# Resend (email/OTP)
RESEND_KEY=your-resend-api-key
```

### Database Setup

Applies strict MongoDB JSON-schema validators to the `users`, `directories`, and `files` collections:

```bash
npm run setup
```

Run this once against a fresh database (and again after any schema change in `config/setup.js`).

### Development

```bash
npm run dev
```

Runs with `node --watch` and loads `.env` automatically, restarting on file changes.

### Production

```bash
npm run build   # npm install
npm start        # node app.js
```

## Background Jobs

Both are started from `app.js` and run for the lifetime of the process:

- **Upload cleanup** — every hour, removes incomplete/orphaned upload records and their storage objects.
- **Subscription expiry** — a 30-second warm-up delay after boot, then once every 24 hours; expires subscriptions past their current billing period.

## Notes on the Upload Flow

Uploads are direct-to-R2, not proxied through the API:

1. `POST /file/:upload/initiate` — server returns a presigned R2 URL and creates a pending file record.
2. Client uploads the file bytes directly to R2 using that URL.
3. `POST /file/:upload/complete` — server confirms the object exists in R2 and finalizes the file record (updates storage usage).
4. `POST /file/:upload/cancel` — discards a pending upload if the client aborts.

This keeps large file transfers off the API server entirely. It is completely separate from, and unaffected by, the profile-picture system below.

## Profile Pictures

Unlike normal files, profile pictures are proxied through the API (not direct-to-R2) and live in their own, deliberately **public** R2 bucket — kept fully separate from the private user-files bucket.

- `PATCH /user/update-profile` (session required, `multipart/form-data`, rate-limited) accepts an optional `name` and an optional `picture` file. At least one must be provided.
- Uploaded images are validated and decoded server-side with `sharp` (HEIC/HEIF from iPhones is converted first via `heic-convert` if the installed `sharp`/libvips build can't decode it directly), then normalized to a `512x512` `image/webp` buffer. The original uploaded file is never stored.
- The processed image is uploaded to `R2_PROFILE_BUCKET_NAME` under a unique, non-guessable key: `profile-images/{userId}/{uuid}.webp`, with `Cache-Control: public, max-age=31536000, immutable`. Every upload gets a brand-new key/URL — old URLs are never reused or overwritten, so there's no CDN cache to invalidate.
- `user.picture` is only updated in MongoDB **after** the new object is confirmed uploaded. The previous custom image (if any) is deleted afterward, and only if it's verified to belong to that same user's own `profile-images/{userId}/` namespace on the profile bucket — the default avatar and Google-hosted avatars are never touched.
- Google Sign-In no longer overwrites a custom profile picture the user has uploaded; it only sets/refreshes the picture when the stored value isn't already a self-uploaded R2 image.
- Profile pictures are application-managed assets, not Drive files — they never touch `usedStorageInBytes`/quota accounting.
- Self and admin hard-delete both clean up a user's custom profile image from the profile bucket (soft delete leaves it untouched, since the account may be restored).

### Cloudflare setup for the profile-image bucket

1. Create a **new, separate** R2 bucket for profile images (e.g. `haadi-profile-images`) — do not reuse the private storage bucket.
2. Leave the existing private bucket's access settings untouched.
3. Attach a Cloudflare custom domain (e.g. `cdn.mirhaadi.in`) to the **new** profile bucket only, and confirm DNS/HTTPS resolve correctly.
4. Set `R2_PROFILE_BUCKET_NAME` to the new bucket's name.
5. Set `R2_PROFILE_PUBLIC_URL` to the custom domain, e.g. `https://cdn.mirhaadi.in`.
6. Do not attach the profile CDN domain to the private bucket, and do not enable public access on the private bucket.

## Known Limitations / In Progress

- Verify that all secrets (Razorpay, R2, Google) are production-grade before going live — the frontend's production-readiness review flagged live-key verification as a launch blocker.
- No global request body size limits beyond the webhook route's explicit `1mb` cap; consider adding one for the general JSON body parser.
- Review rate-limit thresholds under real traffic before launch.

## License

Add your license of choice here.
