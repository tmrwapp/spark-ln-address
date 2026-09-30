-- Make `lightning_names.createdAt` mean what its consumers read it as.
--
-- 20260807120000_username_change added the column as
-- `DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)` and backfilled only
-- `activePubKey`. So every row that existed before that ALTER carries the
-- moment the ALTER ran, not the moment the customer claimed the name — and the
-- API surfaces it as `claimedAt`. The spec accepted the missing backfill on the
-- explicit condition that the value not be presented as a registration date;
-- the ops read endpoint puts it in front of support, where it would say that
-- every long-standing customer claimed their name on deploy day.
--
-- The fix is available in the data: a user and their first name are created in
-- ONE transaction (auth.service.ts), so `users.createdAt` IS that first claim.
--
-- THIS DISCARDS THE VALUES IT OVERWRITES AND PRISMA HAS NO DOWN MIGRATION.
-- Reversal means restoring from a backup. Run the count below first and check
-- it against the size of the pre-ALTER cohort.
--
--   -- rows this will change, and what they look like now:
--   SELECT COUNT(*) FROM `lightning_names` ln
--   JOIN `users` u ON u.`id` = ln.`userId`
--   WHERE ln.`createdAt` > u.`createdAt` + INTERVAL 1 SECOND;
--
--   -- after: expected 0
--   (same query)
--
-- Scope, twice narrowed:
--
--  1. ONE ROW PER USER, their oldest, chosen by ROW_NUMBER rather than by
--     matching the group's MIN value. A value match would update BOTH rows of a
--     user holding two names created in the same millisecond — two racing
--     changeUsername calls can do that — and silently rewrite a real claim date.
--     Ties break on `id`, so the choice is deterministic.
--  2. ONLY ROWS THAT ARE ACTUALLY WRONG, via the one-second threshold. Inside
--     the registration transaction the name row is written microseconds after
--     the user row, so a plain `>` comparison matches nearly every user in the
--     table and rewrites correct dates by a sub-millisecond amount — a write set
--     the size of the whole user base, to fix a cohort that registered days or
--     weeks before the ALTER. A defaulted row misses its true date by that whole
--     gap; a genuine row misses it by microseconds. One second separates them
--     with room to spare.
--
-- A name claimed after the ALTER is never a user's oldest row (before it, a
-- pubkey had at most one row — see the previous migration's own backfill), so
-- no genuine timestamp is in range either way. Re-running is a no-op: the
-- threshold stops matching once the dates agree.
--
-- If `lightning_names` has grown to the point where a full scan at deploy time
-- is not acceptable — there is no index on (userId, createdAt), so the window
-- function reads every row — run this out of band in batches instead, and mark
-- the migration applied. The predicate is the same either way.
UPDATE `lightning_names` AS ln
JOIN `users` AS u
  ON u.`id` = ln.`userId`
JOIN (
  SELECT `id`
  FROM (
    SELECT
      `id`,
      ROW_NUMBER() OVER (
        PARTITION BY `userId`
        ORDER BY `createdAt` ASC, `id` ASC
      ) AS `rn`
    FROM `lightning_names`
  ) AS `ranked`
  WHERE `rn` = 1
) AS `oldest`
  ON `oldest`.`id` = ln.`id`
SET ln.`createdAt` = u.`createdAt`
WHERE ln.`createdAt` > u.`createdAt` + INTERVAL 1 SECOND;
