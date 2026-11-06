-- Lets the expired-nonce purge (issue 30) find rows without a full table scan.
CREATE INDEX `auth_nonces_expiresAt_idx` ON `auth_nonces`(`expiresAt`);
