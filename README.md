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

```text
.
├── app.js                       # Entry point: middleware, routes, cron jobs
├── config/
│   ├── db.js                    # MongoDB connection
│   ├── redis.js                 # Redis client
│   ├── plans.js                 # Subscription plan definitions
│   └── setup.js                 # MongoDB JSON-schema validators
├── controllers/                 # Request handlers
├── middleWares/                 # Authentication, validation, security middleware
├── models/                      # Mongoose schemas
├── routes/                      # Express routers
├── services/                    # External service integrations
├── jobs/
│   └── subscriptionCron.js      # Subscription expiry job
├── observability/               # Logging, metrics and tracing implementation
├── utils/                       # Shared utilities
└── validators/                  # Zod validation schemas
```

## Features

### Authentication
- Email/password registration and login (bcrypt-hashed passwords)
- Email OTP verification via Resend, with strict rate limiting and throttling on send/verify endpoints
- Google OAuth sign-in
- Server-side sessions stored in Redis, keyed by a signed `sid` cookie
- Logout from current session or all sessions (`logout-all`)

### File & Directory Management
- Directory tree operations: create, rename, delete, read contents, resolve full path
- Direct-to-storage file uploads against Cloudflare R2 using presigned URLs, with a three-step lifecycle: `initiate` → client uploads directly to R2 → `complete` (or `cancel`)
- File rename/delete, with input sanitization on user-supplied names
- Bulk delete across files/directories
- Background cleanup job removes stale/incomplete uploads

### Storage Limits & Plans
- Per-user storage quota and device limit enforcement
- `usedStorageInBytes` / `reservedStorage` tracked on the user document
- Subscription plans managed through `config/plans.js`

### Subscriptions & Billing
- Create subscription, verify checkout signature, fetch active subscription, cancel, update payment method link, payment history
- Dedicated `/webhooks/razorpay` route with raw-body and HMAC signature verification
- Daily subscription expiry job

### Role-Based Admin Panel
- Roles ranked by level: `User` (1) < `Manager` (2) < `Admin` (3) < `SuperAdmin` (4)
- Manager+: list users, view plans/subscriptions dashboard (`GET /admin/dashboard/plans`), revoke a user's sessions (`POST /admin/users/:userId/sessions/revoke`)
- Admin+: deactivate/reactivate a user (`PATCH /admin/users/:userId/status` with `{ "isDeleted": true | false }`), change a user's role
- SuperAdmin only: permanently delete a user (`DELETE /admin/users/:userId`)
- Admin+: R2 Storage Usage (`GET /admin/dashboard/storage/usage`, `POST /admin/dashboard/storage/usage/refresh`) — Cloudflare R2 free-tier usage (storage, Class A, Class B) for each configured account (Production always; Personal only when its optional variables are set). Usage snapshots are cached in Redis for 10 minutes
- Role hierarchy enforced through `requireRole(minRole)`, `canManageUser`, and `canAssignRole` helpers

### Security
- `helmet` for HTTP security headers
- CORS restricted to a configurable allow-list (`CLIENT_URLS`)
- Per-route rate limiting and progressive request throttling on sensitive endpoints
- Signed cookies for session IDs
- Sanitization middleware on free-text inputs
- MongoDB collection-level JSON-schema validators as a defense-in-depth layer

## Observability

Implemented a self-hosted observability stack to monitor application health, performance, request behavior, and errors.

### Technology Stack

- **Pino** — structured application logging
- **Prometheus** — application metrics collection
- **Grafana** — metrics and log visualization and dashboards
- **Loki** — centralized log aggregation
- **Grafana Alloy** — log collection and forwarding
- **Tempo** — distributed tracing storage
- **OpenTelemetry** — instrumentation and custom tracing
- **Alertmanager** — alert management and notifications

### What Is Monitored?

- HTTP request counts and failure rates
- Request duration and latency distribution
- In-flight HTTP requests
- Application errors and structured logs
- Custom tracing spans, including password-comparison operations

### Deployment Architecture

The observability implementation is retained in the repository and can be enabled or disabled through the `OBSERVABILITY_ENABLED` environment variable.

| Environment | Custom Observability |
|---|---|
| AWS EC2 | Enabled (`OBSERVABILITY_ENABLED=true`) |
| AWS Lambda | Disabled (`OBSERVABILITY_ENABLED=false`) |

On EC2, the application instrumentation integrates with the self-hosted observability services.

On Lambda, custom Pino, Prometheus, and OpenTelemetry instrumentation is disabled to keep the serverless deployment lightweight. The observability implementation remains available in the codebase for EC2 deployments.

## API Overview

All routes are mounted in the Express application.

| Mount | Router | Auth Required |
|---|---|---|
| `/webhooks` | `webhookRoutes` | Signature-verified, not session-based |
| `/auth` | `authRoutes` | Mixed — register/login/Google/OTP are public and rate-limited; logout routes require a session |
| `/users` | `userRoutes` | Session required |
| `/files` | `fileRoutes` | Session required |
| `/directories` | `directoryRoutes` | Session required |
| `/subscriptions` | `subscriptionRoutes` | Session required |
| `/admin` | `adminRoutes` | Session + appropriate role required |

A centralized error handler returns a generic 500 JSON response and logs server-side errors.

## Getting Started

### Prerequisites

- Node.js (LTS recommended)
- MongoDB instance
- Redis instance
- Cloudflare R2 bucket (or other S3-compatible storage)
- Google OAuth credentials
- Razorpay account and API keys
- Resend account and API key

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
CLIENT_URLS=http://localhost:5173,https://yourapp.com
SESSION_SECRET=your-cookie-signing-secret
COOKIE_SAMESITE=lax

# MongoDB / Redis
DB_URL=mongodb://localhost:27017/haadi-cloud
REDIS_URL=redis://localhost:6379

# Observability
OBSERVABILITY_ENABLED=false

# Google OAuth
GOOGLE_CLIENT_ID=your-google-client-id
GOOGLE_CLIENT_SECRET=your-google-client-secret
REDIRECT_URI=http://localhost:5173/auth/google/callback

# Cloudflare R2 — Private bucket
R2_BUCKET=your-bucket-name
R2_ENDPOINT=https://<account-id>.r2.cloudflarestorage.com
R2_ACCESS_KEY_ID=your-r2-access-key-id
R2_SECRET_ACCESS_KEY=your-r2-secret-access-key

# Cloudflare R2 usage dashboard (Account ID + Analytics Read token)
R2_ACCOUNT_ID=your-cloudflare-account-id
R2_API_TOKEN=your-cloudflare-analytics-read-token

# Cloudflare R2 — Public profile-image bucket
R2_PROFILE_BUCKET_NAME=your-profile-picture-bucket-name
R2_PROFILE_PUBLIC_URL=https://cdn.yourdomain.com

# Razorpay
RAZORPAY_KEY_ID=your-razorpay-key-id
RAZORPAY_KEY_SECRET=your-razorpay-key-secret
RAZORPAY_WEBHOOK_SECRET=your-razorpay-webhook-secret

# Resend
RESEND_KEY=your-resend-api-key

```

#### Optional: Personal R2 account

**Recommended approach:** Use a single Production R2 account for all users. This keeps storage management, configuration, and operations simple and centralized.

The Personal R2 integration is an optional feature intended primarily for personal use cases where specific users need to use a separate R2 account. It is not required for normal deployments, and we recommend avoiding it unless you have a specific reason to maintain separate storage accounts.

Everything works with the Production R2 variables above alone. If needed, you can additionally route specific users to a second R2 account and/or monitor it. The two features are independent:

```env
# Storage routing: only the listed MongoDB user IDs use this account.
# All four bucket/credential variables are required for it to be used.
PERSONAL_R2_BUCKET=
PERSONAL_R2_ENDPOINT=
PERSONAL_R2_ACCESS_KEY_ID=
PERSONAL_R2_SECRET_ACCESS_KEY=
PERSONAL_STORAGE_USER_IDS=id1,id2

# Usage monitoring: a second card on the admin Storage page.
# Both are required, otherwise only Production is shown.
PERSONAL_R2_ACCOUNT_ID=
PERSONAL_R2_API_TOKEN=
```

Configure the appropriate environment variables in your deployment environment. Never commit actual credentials or secrets.

### Database Setup

Apply MongoDB JSON-schema validators:

```bash
npm run setup
```

Run this once against a fresh database and again after any schema changes in `config/setup.js`.

### Development

```bash
npm run dev
```

Runs the application in development mode with automatic restarts.

### Production

```bash
npm run build
npm start
```

Refer to the deployment configuration for the appropriate EC2 or Lambda startup process.

## Background Jobs

The application uses background jobs for maintenance and subscription management:

- **Upload cleanup** — periodically removes incomplete/orphaned upload records and their storage objects.
- **Subscription expiry** — expires subscriptions whose billing period has elapsed.

These jobs run as part of the long-lived EC2 application process. For Lambda deployments, scheduled jobs require a separate scheduler such as AWS EventBridge.

## Notes on the Upload Flow

Uploads are direct-to-R2, not proxied through the API:

1. `POST /files/uploads/initiate` — server returns a presigned R2 URL and creates a pending file record.
2. Client uploads file bytes directly to R2 using that URL.
3. `POST /files/uploads/:uploadId/complete` — server confirms the object exists in R2 and finalizes the file record.
4. `POST /files/uploads/:uploadId/cancel` — discards a pending upload if the client aborts.

The `:uploadId` is the `fileId` returned by step 1 (the pending file record's id).

This keeps large file transfers off the API server entirely. It is separate from the profile-picture upload system.

## Profile Pictures

Unlike normal files, profile pictures are proxied through the API and stored in a separate, deliberately public R2 bucket.

- `PATCH /users/me/profile` accepts an optional `name` and an optional `picture` file.
- Uploaded images are validated and processed using `sharp`; HEIC/HEIF images can be converted using `heic-convert`.
- Images are normalized to a `512x512` WebP buffer.
- Each upload receives a unique key under `profile-images/{userId}/`.
- Processed images are served through a dedicated Cloudflare CDN domain.
- Previous custom images are deleted only after the new upload succeeds and ownership is verified.
- Google Sign-In does not overwrite a custom profile picture.
- Profile pictures are not included in user storage quota accounting.
- Hard-delete operations clean up custom profile images; soft-delete leaves them untouched.

### Cloudflare Setup for Profile Images

1. Create a separate R2 bucket for profile images.
2. Keep the existing private storage bucket's access settings unchanged.
3. Attach a Cloudflare custom domain to the profile-image bucket only.
4. Configure `R2_PROFILE_BUCKET_NAME` and `R2_PROFILE_PUBLIC_URL`.
5. Never enable public access on the private user-files bucket.

## Known Limitations / In Progress

- Verify that all production credentials and payment integrations are configured correctly before launch.
- Consider adding a global request body size limit for the general JSON body parser.
- Review rate-limit thresholds under real traffic before launch.

## Testing

Tests run on [Vitest](https://vitest.dev) + [supertest](https://github.com/ladjs/supertest). They need **no database, Redis, R2, Razorpay, Google or Resend** — every external dependency is mocked — so they run offline in ~20 seconds, locally and in CI.

```bash
npm test                 # everything (this is what CI runs before every deploy)
npm run test:unit        # pure logic
npm run test:integration # the real Express app over HTTP
npm run test:smoke       # boot + deployment-config checks
npm run test:coverage    # with a coverage report
npm run test:watch       # re-run on change
```

| Folder | Covers |
| --- | --- |
| `tests/unit/validators` | Zod schemas (auth, directory, file, subscription) |
| `tests/unit/middleware` | session auth + role guard, id validation, input sanitising, rate limiting/throttling, profile upload limits |
| `tests/unit/utils` | role permissions, premium status, sessions/device limit, directory tree, upload cleanup, image processing |
| `tests/unit/services` | R2 (signed URLs, bucket routing, batched deletes), storage up/downgrade, OTP e-mail, Google auth |
| `tests/unit/models` | Mongoose schemas, defaults, unique indexes, password comparison |
| `tests/unit/jobs` | subscription-expiry cron |
| `tests/integration` | every route group: app/CORS/errors, auth, user, directory, file/upload, subscription, Razorpay webhook, admin |
| `tests/smoke` | app + Lambda handler boot, `.env.example` completeness, PM2/workflow consistency |

Shared helpers live in `tests/helpers`; global mocks are in `tests/setup`.

CI: `.github/workflows/test.yml` runs on pull requests, and both deploy workflows now run the suite in a `test` job that the deploy job `needs`, so a failing test blocks the deployment.
