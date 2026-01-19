# Spark LN Address

Lightning Address provider for Spark-based mobile apps. It implements LNURL-Pay (LUD-06/LUD-16) to generate BOLT11 invoices via Lightspark and LNURL-Auth (LUD-04) for self-serve username registration (`username@domain`). Built with NestJS, Prisma, and MySQL.

## What it does
- Resolves `username@domain` Lightning Addresses to LNURL-Pay metadata.
- Generates invoices through the Lightspark SDK and records them in MySQL.
- Issues LNURL-Auth challenges and binds usernames to linking pubkeys.
- Enforces username normalization/availability and fixed min/max sendable msats.

## Architecture (high level)
- `lnurl`: serves pay metadata and callback to create invoices.
- `auth`: LNURL-Auth challenge and callback to verify signatures and register usernames.
- `lightspark`: wraps `@buildonspark/spark-sdk` to mint invoices.
- `prisma`: MySQL models for users, lightning names, auth nonces, invoices.
- `config`: env configuration; app boots on port `3003` by default.

## Data model (Prisma)
- `User`: base account.
- `LightningName`: `username` (unique), `linkingPubKeyHex` (LNURL-Auth), `active`.
- `AuthNonce`: LNURL-Auth `k1` nonce with expiry/usage tracking.
- `Invoice`: amount (msat), `bolt11`, `expiresAt`, status, linked to `LightningName`.

## API

### Query (V1)
- `GET /v1/query/username/:pubKey`
  - Returns `{ username, lightningAddress, sparkAddress, publicKey }` for an active linking pubkey.
- `GET /v1/query/pubkey/:username`
  - Returns `{ username, lightningAddress, sparkAddress, publicKey }` for an active username.

### LNURL-Pay (LUD-16)
- `GET /.well-known/lnurlp/:username`
  - Validates username exists/active.
  - Returns `tag: "payRequest"`, `callback`, `minSendable`, `maxSendable`, `metadata` (`text/plain` with `username@domain`), `commentAllowed`.
- `GET /lnurl/callback/:username?amount=<msat>&comment=<text>`
  - Validates amount within configured min/max.
  - Creates invoice via Lightspark and returns `{ pr, routes: [] }`.

### LNURL-Auth (LUD-04)
- `GET /v1/auth/lnurl`
  - Returns `{ tag: 'login', k1, callback }` with 5-minute expiry stored in DB.
- `GET /v1/auth/lnurl/callback?k1=...&sig=...&key=...&username=...`
  - Verifies signature over `k1` with provided pubkey.
  - Normalizes/validates username, checks availability, stores Lightning Name, and marks nonce as used.

## Configuration
Copy `env.example` to `.env` and adjust as needed.

Required:
- `DATABASE_URL` — MySQL connection (dev compose maps `3308->3306`).
- `PUBLIC_BASE_URL` — public URL used to build LNURL callbacks/metadata.

Optional:
- `PORT` (default 3003)
- `RATE_LIMIT_WINDOW_MS`, `RATE_LIMIT_MAX`

## Run locally
1) Install deps: `npm install`
2) Start MySQL (dev): `docker-compose up -d mysql` (uses port 3308)
3) Set env: `cp env.example .env` and fill values
4) Generate Prisma client (after DB is reachable): `npx prisma generate`
5) Start API: `npm run start:dev`

Production build: `npm run build` then `npm run start:prod`.

## Database & migrations
This service uses Prisma with MySQL. If you update the schema, run your own Prisma migrations (`npx prisma migrate dev` or `npx prisma migrate deploy`) against the appropriate database. Do not run migrations in environments you don't control without confirmation.

## Testing
- Unit tests: `npm run test`
- E2E tests (requires test DB on port 3309): `npm run test:e2e`
- E2E setup/teardown helpers: `npm run test:e2e:setup`, `npm run test:e2e:teardown`, or `npm run test:e2e:full`
- Coverage: `npm run test:cov`

E2E tests use a separate MySQL container (`mysql-test` profile) and database `spark_ln_address_test`.

## Notes
- Lightning Addresses resolve to `username@<PUBLIC_BASE_URL domain>`.
- Min/max sendable amounts and comment allowance are fixed in `src/common/constants.ts`.
- Spark SDK must be able to initialize at startup; ensure credentials are valid.
