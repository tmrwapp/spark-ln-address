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
-- Scope is each user's OLDEST row only, which is exactly the set that can be
-- wrong:
--   * before the ALTER a pubkey had at most one row (the previous migration's
--     own backfill comment states this), so a pre-existing user's oldest row is
--     the defaulted one;
--   * a name claimed AFTER the ALTER is never a user's oldest row, so a genuine
--     timestamp is never overwritten;
--   * a user who registered after the ALTER has a correct oldest row already,
--     and rewriting it to `users.createdAt` moves it by the milliseconds
--     between two statements of one transaction.
--
-- `ln.createdAt > u.createdAt` keeps it from moving any date backwards past the
-- user it belongs to, and makes a second run a no-op.
UPDATE `lightning_names` AS ln
JOIN `users` AS u
  ON u.`id` = ln.`userId`
JOIN (
  SELECT `userId`, MIN(`createdAt`) AS `firstCreatedAt`
  FROM `lightning_names`
  GROUP BY `userId`
) AS f
  ON f.`userId` = ln.`userId`
 AND ln.`createdAt` = f.`firstCreatedAt`
SET ln.`createdAt` = u.`createdAt`
WHERE ln.`createdAt` > u.`createdAt`;
