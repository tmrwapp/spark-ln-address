-- Username change support.
--
-- A user's name history becomes the set of their `lightning_names` rows: exactly
-- one is active, the rest are retired. Retired rows keep the `username` unique
-- index occupied, which is what makes a retired name permanently unavailable to
-- everyone (including its original owner's quota, which counts rows).
--
-- `linkingPubKeyHex` therefore stops being unique per row, since one user now
-- owns several rows carrying the same pubkey. The "one ACTIVE name per pubkey"
-- half of that guarantee moves to `activePubKey`, a nullable mirror of the
-- pubkey that is set while the row is active and NULL once retired. MySQL treats
-- NULLs as distinct in a unique index, so unlimited retired rows coexist with a
-- single active one.

-- 1. Relax pubkey uniqueness, keep it indexed for the auth lookup path.
DROP INDEX `lightning_names_linkingPubKeyHex_key` ON `lightning_names`;

CREATE INDEX `lightning_names_linkingPubKeyHex_idx` ON `lightning_names`(`linkingPubKeyHex`);

CREATE INDEX `lightning_names_userId_idx` ON `lightning_names`(`userId`);

-- 2. Re-establish "at most one active name per pubkey".
ALTER TABLE `lightning_names`
  ADD COLUMN `activePubKey` VARCHAR(191) NULL,
  ADD COLUMN `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  ADD COLUMN `updatedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3);

-- Backfill: every pre-existing row is active and is the only row for its pubkey.
UPDATE `lightning_names` SET `activePubKey` = `linkingPubKeyHex` WHERE `active` = 1;

CREATE UNIQUE INDEX `lightning_names_activePubKey_key` ON `lightning_names`(`activePubKey`);

-- 3. Support-grantable ceiling for username changes.
ALTER TABLE `users`
  ADD COLUMN `bonusUsernameChanges` INT NOT NULL DEFAULT 0;
