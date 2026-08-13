# Lightning Username Change — Specification

Let a user change the `name` part of their `name@guap.to` Lightning address, retiring the
previous name permanently and allowing an unlimited switch back to any name the user has
previously owned.

| | |
|---|---|
| Status | Ready to build |
| Repo | spark-ln-address @ `develop` |
| Baseline | 3657069 |
| Rules decided by | Ari |

## Contents

1. [Product rules](#1-product-rules)
2. [Behaviour on change](#2-behaviour-on-change)
3. [Worked scenario](#3-worked-scenario)
4. [Data model](#4-data-model)
5. [Migration](#5-migration)
6. [API](#6-api)
7. [Change logic](#7-change-logic)
8. [Security](#8-security)
9. [Ops endpoint](#9-ops-endpoint)
10. [Mobile app changes](#10-mobile-app-changes)
11. [Accepted limitations](#11-accepted-limitations)
12. [Test plan](#12-test-plan)
13. [Rollout](#13-rollout)
14. [Decisions and remaining questions](#14-decisions-and-remaining-questions)

---

## 1. Product rules

Decided by Ari: mirror the Cash App `$cashtag` rules.

| Rule | Decision | Detail |
|---|---|---|
| Old name | **Retired forever** | The previous name is never released back to the pool. No other user can ever claim it, and nobody can pay the user through it. |
| Change limit | **2 new names** | A user may claim at most two brand-new names over the lifetime of the account, so at most three names in total including the one chosen at registration. |
| Switch back | **Unlimited & free** | Every name the user has ever owned stays reserved for that user. Switching back to one of them is always allowed and never consumes the change quota. |
| Support exception | **Grantable** | Support can grant an individual user extra changes beyond the two. The grant raises that user's ceiling and is applied through an internal endpoint, never by the user. |
| Cooldown | **None** | No waiting period between changes. Instead, the API always reports the remaining quota and the app must show it to the user before a change is consumed. |

> **Provenance.** The rules come from a Google AI Overview describing Cash App behaviour,
> forwarded by Ari as the decision to follow. They are treated here as *our* product decision,
> not as verified Cash App behaviour. Nothing in this spec depends on Cash App actually
> implementing it this way.

### Restated precisely

1. A username is globally unique across every user and across active and retired names alike.
2. Once a name has been owned by a user it belongs to that user forever, whether active or retired.
3. Exactly one of a user's names is active at any moment. Only the active name resolves for payments.
4. Claiming a name nobody has ever owned consumes one unit of quota. The quota is two, plus any grant given by support.
5. Re-activating a name the user already owns consumes nothing and has no cap.
6. The remaining quota is part of every response, and the app must show it before the user consumes a change.

---

## 2. Behaviour on change

What breaks, what survives, and what the current code already does correctly.

| Surface | Behaviour after a change | Status |
|---|---|---|
| `GET /.well-known/lnurlp/:username` on the old name | Returns `404 Username not found`. `findActiveLightningName` already filters `active: true`, so a retired row is invisible to the pay path with no code change. | Free |
| `GET /v1/query/pubkey/:username` on the old name | Returns an empty array. Same `active: true` filter in `query.service.ts`. | Free |
| `GET /v1/query/username/:pubKey` | Returns the new active name. Uses `findFirst` with `active: true`. | Free |
| Signed-request authentication | Unaffected. `SparkSignatureGuard` resolves the user by `linkingPubKeyHex` plus `active: true`, and the new row carries the same pubkey. | Free |
| BOLT11 invoices already issued under the old name | Stay valid and payable. `Invoice.usernameId` is a foreign key to `lightning_names.id`, not to the name string, and the retired row is never deleted. | Free |
| Flashnet orders, webhooks and refund cases in flight | Unaffected. They hang off `Invoice`, which hangs off the row id. | Free |
| Spark address of the user | Unchanged. It is derived from `linkingPubKeyHex`, which the change never touches. | Free |
| Another user's saved contact holding the old address | Becomes a dead address. Contacts live in each device's local storage, so they cannot be updated or invalidated remotely. | Accepted loss |
| Printed QR codes, social bios, shared invoices | Same as above. There is no alias, forwarding or grace period, and none is planned. | Accepted loss |
| A stranger claiming the freed name | Impossible by construction. The retired row keeps the unique index on `username` occupied forever. | Prevented |

> **Why so much comes for free.** Every read path in the service already filters on `active: true`
> (`src/lnurl/lnurl.service.ts`, `src/query/query.service.ts`, `src/auth/spark-signature.guard.ts:88`),
> yet no code anywhere writes `active = false`. The column is a dormant flag that was clearly
> designed for exactly this feature. This spec activates it rather than inventing a parallel
> mechanism.

---

## 3. Worked scenario

One user, the full lifecycle, showing how the quota is counted.

| Action | Resulting state |
|---|---|
| Registers as `alice` | rows: [alice **active**] · changes used 0 of 2 |
| Changes to `bob` *(new name)* | rows: [alice retired, bob **active**] · changes used 1 of 2 |
| Switches back to `alice` *(free)* | rows: [alice **active**, bob retired] · changes used 1 of 2 |
| Changes to `carol` *(new name)* | rows: [alice retired, bob retired, carol **active**] · changes used 2 of 2 |
| Tries a fourth name `dave` | rejected with `409 CHANGE_LIMIT_REACHED` |
| Switches back to `bob` *(free)* | rows: [alice retired, bob **active**, carol retired] · changes used 2 of 2, still allowed |

> **The counting trick.** Changes used is not stored. It is **derived** as
> `count(rows for this user) - 1`. Claiming a new name inserts a row and therefore increments it;
> switching back only flips two boolean flags and therefore does not. No counter column, no
> counter drift, no way for the two to disagree. The *ceiling* is the one stored number, because
> support can raise it: `2 + user.bonusUsernameChanges`.

---

## 4. Data model

No new table and no new column are required.

A user's name history is the set of their `LightningName` rows. One row is `active`, the rest are
retired. Since `username` already carries a global unique index, that single index enforces rule 1
(global uniqueness) and rule 2 (permanent reservation) at the database level, with no cross-table
check and no race window.

### The one blocker

`LightningName.linkingPubKeyHex` is declared `@unique` (`prisma/schema.prisma:34`). A user with two
rows would repeat their own pubkey and violate it. That constraint must be relaxed from "unique per
row" to "unique among *active* rows".

```diff
  // prisma/schema.prisma
  model LightningName {
    id                  String  @id @default(cuid(2))
    username            String  @unique
    userId              String
-   linkingPubKeyHex    String  @unique // secp256k1 public key hex for LNURL-Auth
+   linkingPubKeyHex    String          // secp256k1 public key hex for LNURL-Auth
    active              Boolean @default(true)
+   createdAt           DateTime @default(now())
+   updatedAt           DateTime @updatedAt

    user     User      @relation(fields: [userId], references: [id], onDelete: Cascade)
    invoices Invoice[]

+   @@index([linkingPubKeyHex])
+   @@index([userId])
    @@map("lightning_names")
  }
```

`createdAt` and `updatedAt` are additive and optional to the feature itself, but they are what
makes the history list orderable and the change auditable. They are cheap to add now and awkward
to backfill later.

### The one stored number

Since support can grant extra changes, the *ceiling* cannot be a constant. It is the only value
that has to be persisted, and it lives on `User`:

```diff
  // prisma/schema.prisma
  model User {
    id                       String   @id @default(cuid(2))
    createdAt                DateTime @default(now())
    updatedAt                DateTime @updatedAt
    defaultReceivingCurrency ReceivingCurrency @default(USDB)
+   bonusUsernameChanges     Int      @default(0)

    lightningNames LightningName[]

    @@map("users")
  }
```

The effective limit is `2 + bonusUsernameChanges`. Usage stays derived from the row count, so a
grant can never desynchronise from reality: it raises the ceiling and nothing else.

### Enforcing one active row per pubkey

Dropping the unique index removes a real guarantee, so it must be replaced. Two options:

| Option | How | Trade-off |
|---|---|---|
| **A. Nullable mirror column** *(shipped)* | A plain nullable `activePubKey` holding a copy of the pubkey while the row is active and `NULL` once retired, with a unique index. MySQL allows many `NULL`s in a unique index, so unlimited retired rows coexist with exactly one active row per pubkey. The application writes it in the same statement that flips `active`. | Prisma-native, so it survives future `migrate` runs. The database still catches the dangerous case, because two active rows for one pubkey would collide on the index. The application does have to keep the column in step with `active`, which the tests assert. |
| **B. Generated column** *(rejected)* | The same column, but computed by MySQL as `IF(active, linkingPubKeyHex, NULL)` so it can never fall out of step. | Airtight in principle, but Prisma cannot express a generated column. The next `prisma migrate dev` would read it as drift and generate a migration dropping the very index that protects the invariant. Trading a silent landmine for a redundancy the tests already cover is a bad deal. |
| **C. Application-level only** *(not needed)* | Flip the flags inside a single Prisma `$transaction` and rely on nothing else. | Would have been acceptable, since PM2 runs one process (`ecosystem.config.cjs`: `instances: 1`, `exec_mode: 'fork'`) and there is no concurrent writer today. Option A costs one column and keeps the guarantee if that ever changes. |

**A** shipped. Either way the write path is wrapped in a transaction, and it deactivates before
activating so the unique index is never momentarily doubled.

---

## 5. Migration

MySQL 8, Prisma Migrate. This repo has a real migration history, unlike the Supabase projects.

```sql
-- prisma/migrations/<timestamp>_username_change/migration.sql

-- 1. Relax the pubkey uniqueness to allow retired rows
DROP INDEX `lightning_names_linkingPubKeyHex_key` ON `lightning_names`;
CREATE INDEX `lightning_names_linkingPubKeyHex_idx` ON `lightning_names`(`linkingPubKeyHex`);
CREATE INDEX `lightning_names_userId_idx` ON `lightning_names`(`userId`);

-- 2. Re-establish "one active name per pubkey" (Option A), plus audit timestamps.
--    Existing rows get the migration time for `createdAt`.
ALTER TABLE `lightning_names`
  ADD COLUMN `activePubKey` VARCHAR(191) NULL,
  ADD COLUMN `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  ADD COLUMN `updatedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3);

-- Backfill before the index exists: every pre-existing row is active and is the
-- only row for its pubkey.
UPDATE `lightning_names` SET `activePubKey` = `linkingPubKeyHex` WHERE `active` = 1;

CREATE UNIQUE INDEX `lightning_names_activePubKey_key`
  ON `lightning_names`(`activePubKey`);

-- 3. Support-grantable ceiling
ALTER TABLE `users`
  ADD COLUMN `bonusUsernameChanges` INT NOT NULL DEFAULT 0;
```

> **Verify before running.** The index name `lightning_names_linkingPubKeyHex_key` is Prisma's
> default naming convention and must be confirmed against the live database
> (`SHOW INDEX FROM lightning_names`) before the migration is applied. `createdAt` on pre-existing
> rows will read as the migration timestamp, not the real registration time. That is acceptable;
> it should not be presented to users as a registration date.

---

## 6. API

A new `username` module, structurally identical to the existing `currency-preference` module.

Both endpoints sit behind `SparkSignatureGuard`, so the caller proves possession of the Spark
identity key by signing `{METHOD}:{url}:{timestamp}:{bodyHash}` as documented in
[spark-signature-auth.md](./spark-signature-auth.md). No new authentication work is needed.

### GET /v1/users/me/username

Returns the active name, the full history and the remaining quota, so the app can render the
screen without guessing.

```json
{
  "username": "carol",
  "lightningAddress": "carol@guap.to",
  "changesUsed": 2,
  "changesLimit": 2,
  "changesRemaining": 0,
  "history": [
    { "username": "carol", "active": true,  "claimedAt": "2026-08-07T13:02:11.000Z" },
    { "username": "bob",   "active": false, "claimedAt": "2026-07-30T09:44:02.000Z" },
    { "username": "alice", "active": false, "claimedAt": "2026-06-01T18:20:55.000Z" }
  ]
}
```

### PATCH /v1/users/me/username

Body: `{ "username": "bob" }`, validated by a `class-validator` DTO plus `normalizeUsername`.

```json
{
  "username": "bob",
  "lightningAddress": "bob@guap.to",
  "changesUsed": 2,
  "changesLimit": 2,
  "changesRemaining": 0,
  "switchedBack": true
}
```

`switchedBack` tells the client whether the operation consumed quota, so the UI can explain itself
accurately.

> **Quota fields are a hard requirement, not decoration.** `changesLimit` and `changesRemaining`
> are returned by **both** endpoints and both are computed server-side as
> `2 + bonusUsernameChanges` and `limit - used`. The app must never derive the remaining count from
> a hard-coded 2, because a support grant raises the ceiling for that user only and the client has
> no other way to learn it.

### Responses

| Status | `code` | When |
|---|---|---|
| 200 | — | Name changed or switched back. |
| 400 | `INVALID_USERNAME` | Fails `^[a-z0-9._-]{1,30}$` in `normalizeUsername`. |
| 400 | `SAME_USERNAME` | Target equals the currently active name. Rejected rather than treated as a silent no-op, so the client never reports a change that did not happen. |
| 401 | — | Guard rejection: missing headers, timestamp skew, bad signature, unknown pubkey, or a replayed request. |
| 409 | `USERNAME_TAKEN` | The name is active or retired under any account, including a name retired by a different user. |
| 409 | `CHANGE_LIMIT_REACHED` | The user's ceiling of `2 + bonusUsernameChanges` new names is already spent and the target is not in this user's history. |

> **Deliberate leak.** `USERNAME_TAKEN` does not distinguish "active elsewhere" from "retired
> elsewhere". Both are equally unavailable, and separating them would tell a caller that a specific
> name was once in use. The existing `.well-known/lnurlp/` probe already reveals which names are
> *active*; it must not start revealing retired ones, so retired names stay 404 there.

---

## 7. Change logic

One transaction, five checks. `UsernameService.changeUsername(userId, rawUsername)`.

1. **Normalize.** Run `normalizeUsername`. A throw becomes `400 INVALID_USERNAME`. Every comparison
   below uses the normalized form.
2. **Load the user's rows.** All `LightningName` rows for `userId`. One is active; identify it and
   the target.
3. **Classify the request.** Target present in the user's own rows means *switch back*, free and
   always permitted. Otherwise it is a *new claim* and consumes quota.
4. **Gate the new claim.** Reject with `409 CHANGE_LIMIT_REACHED` when
   `rows.length - 1 >= 2 + user.bonusUsernameChanges`. Then check global availability; a hit
   anywhere in `lightning_names` is `409 USERNAME_TAKEN`.
5. **Apply in one transaction.** Set the current active row to `active: false`, then either flip
   the existing target row to `active: true` or insert a new row with the same `linkingPubKeyHex`.
   Catch Prisma `P2002` and map it to `409 USERNAME_TAKEN`, which closes the check-then-act window.

> **Order matters.** Deactivate before activating. With the `activePubKey` unique index in place,
> activating first would momentarily leave two active rows carrying the same pubkey and the
> statement would fail.

### What registration needs, and what it does not

`AuthService.verifyAndBindUsername` checks availability with `findUnique({ where: { username } })`,
which has no `active` filter. Retired rows therefore block re-registration *already*, with no change
at all: permanent reservation falls out of the data model rather than having to be coded. An earlier
draft of this spec claimed otherwise; that claim applied to a history-table design, not to the one
that shipped. A regression test pins the behaviour.

Registration still changes, for two unrelated reasons:

- It must write `activePubKey` on the new row, or the invariant is unenforced for freshly
  registered users.
- Its check-then-act window is pre-existing: two registrations racing on one name both pass the
  check and one loses at the unique index. It now creates the `User` and the `LightningName` in a
  single transaction, so a loser cannot leave an orphaned `User` behind, and reports `P2002` as a
  taken username rather than a 500.

---

## 8. Security

### Replay protection is now mandatory

`docs/spark-signature-auth.md` defers the replay LRU with an explicit condition: *"Revisit when a
non-idempotent signed endpoint ships."* This is that endpoint. Replaying a captured `PATCH` within
the 60 second skew window would consume quota a second time, and after the quota is exhausted it
would silently flip the user's active name.

Add to `SparkSignatureGuard` an in-memory LRU keyed by `sha256(pubkey|timestamp|signature)`, with
entries expiring after `AUTH_MAX_SKEW_MS`. A hit is `401`. This is sound because PM2 runs a single
fork process; if the service is ever scaled to multiple instances or replicas, the LRU stops
protecting and must move to shared storage.

### Abuse surface

| Vector | Mitigation |
|---|---|
| Name squatting through repeated registration | Unchanged by this feature, but note the quota only limits *changes*. Nothing stops one person creating many wallets and registering many names, which is the pre-existing situation. |
| Unlimited switch-back flapping | Free and uncapped by rule, with no cooldown by decision. Each call is a cheap two-row update, so the impact is load rather than harm, and the names involved are all already owned by that user. |
| Abuse of the support grant | The grant endpoint is bearer-token protected and fail-closed. `amount` is capped and negative values are rejected, so a single call cannot hand out an unbounded allowance. |
| Enumerating retired names | Not possible through the public paths: `.well-known/lnurlp/` and `/v1/query/` both filter `active: true`. Only `PATCH` reveals unavailability, and it requires a valid signature. |
| Stolen identity key | An attacker with the key can already spend. Renaming is strictly less severe and is bounded by the quota. |

---

## 9. Ops endpoint

Confirmed by Ari: support can grant an extra change. Ships with the feature.

Because `changesUsed` is derived from the row count, it cannot be decremented. A grant therefore
raises the ceiling through `User.bonusUsernameChanges` (see section 4) rather than rewriting
history. The endpoint reuses `InternalOpsGuard` (bearer `INTERNAL_OPS_TOKEN`, fail-closed when
unset, constant-time compare), matching the existing `v1/internal/refund-cases` surface:

```http
POST /v1/internal/username-changes/:pubkey/grant
Authorization: Bearer <INTERNAL_OPS_TOKEN>

{ "amount": 1, "reason": "typo in original registration" }

// 200
{
  "pubkey": "02698ba4…",
  "username": "carol",
  "changesUsed": 2,
  "changesLimit": 3,
  "changesRemaining": 1
}
```

The user is addressed by `linkingPubKeyHex`, because that is the identifier support can obtain from
the customer and from the existing query endpoints. The internal `User.id` is not exposed anywhere
today and should not start being exposed for this.

| Rule | Behaviour |
|---|---|
| `amount` | Positive integer, increments the existing bonus. Capped at a small value (suggest 5) so a typo cannot hand out an unbounded allowance. |
| `reason` | Required, non-empty. Logged with the grant. The endpoint has no audit table, so the structured log is the only record; that is consistent with how refund-case ops behave today. |
| Unknown pubkey | `404`. No user is created implicitly. |
| Revoking a grant | Not supported. Negative amounts are rejected. Removing an allowance that a user may have already spent has no coherent meaning. |

> **The token must actually be set.** `INTERNAL_OPS_TOKEN` is empty in `env.example` and
> `InternalOpsGuard` fails closed when unset, rejecting every request with
> `401 Ops endpoint is not configured`. If the production environment has never set it, the grant
> endpoint will appear broken rather than protected. Verify it is set before support is told the
> feature exists.

---

## 10. Mobile app changes

Repo `guap-rn`. Backend and app ship independently; the endpoint is additive.

| File | Change |
|---|---|
| `packages/lightning-address/src/lightningAddressService.ts` | Add `getUsernameInfo()` and `changeUsername(name)`. Both build the canonical message and sign it with the identity key, which is a new capability for this service; it currently only signs the registration `k1`. Rule 34 keeps this in `packages/`, not in the app. |
| `packages/lightning-address/src/lightningAddressService.ts` | The singleton caches `username` and `lightningAddress` and can only populate them through `initialize()`, which throws if already initialized. A rename needs an internal refresh path that updates the cached pair without tearing down the instance via `reset()`. |
| `apps/guap/src/hooks/settings/useLightningAddress.ts` | Reuse `filterUsernameInput` and the debounced availability check. Note its `validateUsername` allows up to 64 characters while the server caps at 30 through `normalizeUsername`; the client rule must be tightened to match or users will hit a server-side `400` after the UI said the name was fine. |
| `apps/guap/src/screens/Settings/…` | New screen: current address, remaining changes, the history list with a tap-to-switch-back action, and a confirmation step (see the quota warning below). |

### The quota warning is a requirement

Ari's decision replaces a cooldown with disclosure: there is no waiting period, so the only thing
standing between a user and an exhausted quota is the app telling them. The confirmation step,
shown before the change is submitted, must state all of the following:

1. **How many changes remain after this one.** Read from `changesRemaining` in
   `GET /v1/users/me/username`, never from a hard-coded 2. A user granted an exception by support
   has a higher ceiling and the app only learns it from the API.
2. **That this one is free, when it is.** Switching back to a name already in the history consumes
   nothing. The app knows this before calling, because the target appears in `history`. The
   confirmation for a switch back must not warn about spending quota.
3. **That the old address stops working immediately.** And that saved contacts held by other people
   will break, with no way to notify them.
4. **That the old name stays yours.** Nobody else can take it and the user can switch back at any
   time, for free. This is the reassuring half and it materially changes how risky the action feels.

> **Last change deserves a stronger step.** When `changesRemaining` would reach 0, the confirmation
> should say so explicitly rather than reusing the generic copy. After that point the user can only
> cycle among names they already own, and support intervention is the only way out.

---

## 11. Accepted limitations

Explicitly out of scope. Listed so they are decisions rather than oversights.

- **No forwarding or alias.** The old address returns 404 immediately. Cash App behaves the same
  way, so following its rules does not remove this.
- **No notification to payers.** There is no registry of who saved a given address, so nobody can
  be told it changed.
- **Contacts on other devices are not repairable.** They are local to each device and hold the
  address as a literal string.
- **No cooldown between changes.** Decided deliberately. The quota plus the in-app disclosure of
  the remaining count replace a waiting period, so a user can change and switch back as fast as
  they like.
- **No name reclamation for deleted accounts.** Out of scope, and the current service has no
  account-deletion flow.

---

## 12. Test plan

Jest unit specs beside each file, plus e2e against the test MySQL on port 3309.

| Level | Case | Expected |
|---|---|---|
| Unit — `username.service.spec.ts` | Change to an unused name, quota available | 200, old row retired, new row active, `changesUsed` incremented |
| Unit — `username.service.spec.ts` | Change to a name in own history | 200, `switchedBack: true`, `changesUsed` unchanged |
| Unit — `username.service.spec.ts` | Change to a name active under another user | 409 `USERNAME_TAKEN` |
| Unit — `username.service.spec.ts` | Change to a name *retired* under another user | 409 `USERNAME_TAKEN` |
| Unit — `username.service.spec.ts` | Third new name | 409 `CHANGE_LIMIT_REACHED` |
| Unit — `username.service.spec.ts` | Switch back after the quota is exhausted | 200, still permitted |
| Unit — `username.service.spec.ts` | Target equals current active name | 400 `SAME_USERNAME` |
| Unit — `username.service.spec.ts` | Uppercase, padded and invalid-character input | Normalized or 400, matching `normalizeUsername` |
| Unit — `username.service.spec.ts` | User with `bonusUsernameChanges: 1` claims a third new name | 200, `changesLimit: 3` |
| Unit — `username.service.spec.ts` | Same user attempts a fourth | 409 `CHANGE_LIMIT_REACHED` |
| Unit — `username-ops.controller.spec.ts` | Grant without a bearer token, and with a wrong one | 401 in both cases |
| Unit — `username-ops.controller.spec.ts` | Grant with `amount: 1` on a known pubkey | 200, ceiling raised by one, reason logged |
| Unit — `username-ops.controller.spec.ts` | Grant with a negative, zero or over-cap `amount` | 400, bonus unchanged |
| Unit — `spark-signature.guard.spec.ts` | Same signature replayed inside the skew window | 401 |
| Unit — `spark-signature.guard.spec.ts` | LRU entry expired, signature reused | 401 by timestamp skew, not by the LRU |
| Unit — `spark-signature.guard.spec.ts` | Guard resolves the user after a rename | Resolves through the new active row |
| e2e | Register, change twice, attempt a third | Final attempt 409 |
| e2e | `.well-known/lnurlp/` on the retired name | 404 |
| e2e | `/v1/query/username/:pubKey` after a rename | Returns the new name only |
| e2e | Invoice created before the rename | Still readable and still linked to the retired row |

The registration change also needs a regression test: registering a name that is retired under
another user must be rejected. That single test is what proves permanent reservation actually holds.

---

## 13. Rollout

1. **Verify index names on the live database.** `SHOW INDEX FROM lightning_names` before writing
   the final migration SQL.
2. **Back up.** The migration drops a unique index. Take a dump first; there is a single production
   MySQL behind this service.
3. **Apply the migration.** `npx prisma migrate deploy`. Existing rows keep their data; they only
   gain the two timestamp columns and a `bonusUsernameChanges` of 0.
4. **Confirm `INTERNAL_OPS_TOKEN` is set in production.** The grant endpoint ships with the feature
   and `InternalOpsGuard` fails closed. No new variable is introduced, but this existing one must
   actually hold a value.
5. **Deploy and restart.** `npm run build` then `pm2 restart spark-ln-address`.
6. **Backend first, app after.** The endpoints are additive, so the current app build keeps working
   untouched. The Settings screen can follow in the next release.

There is no feature flag proposed. The endpoint is inert until the app calls it, which makes a flag
redundant. If a staged rollout is wanted anyway, the cheapest gate is an env variable checked in the
controller, following the `USDB_ENABLED` pattern already in `env.example`.

---

## 14. Decisions and remaining questions

Nothing here blocks implementation.

### Settled

| Question | Decision | Where it lands |
|---|---|---|
| Is the old name blocked after a change? | **Yes, forever.** Retired and reserved for the original owner. | Sections 1, 4 |
| How many changes per user? | **Two new names.** Switching back is unlimited and free. | Sections 1, 7 |
| Can support grant an extra change? | **Yes.** Ari, 2026-08-07. Ships with the feature. | Sections 4, 9 |
| Cooldown between changes? | **No.** Replaced by mandatory in-app disclosure of the remaining quota before each change. | Sections 6, 10 |
| Support script for a dead address | **Out of scope.** Handled outside this spec. | — |

### Resolved during implementation

**Q1 — closed — Generated column versus application-level invariant.** Neither. A plain nullable
`activePubKey` with a unique index ships instead, because a generated column is not expressible in
the Prisma schema and the next `prisma migrate dev` would drop the index protecting the invariant.
See section 4.

**Q2 — closed — Cap on a single grant.** Set to 5 per call (`MAX_GRANT_PER_CALL`), enforced by the
DTO alongside a minimum of 1, so a negative or fat-fingered amount is rejected before it reaches the
service.

---

*spark-ln-address · `docs/username-change.md` · baseline commit 3657069 on `develop`*
