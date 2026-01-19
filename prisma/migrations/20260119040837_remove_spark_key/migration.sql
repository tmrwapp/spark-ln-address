/*
  Warnings:

  - You are about to drop the column `sparkPubKeyHex` on the `lightning_names` table. All the data in the column will be lost.

*/
-- AlterTable
ALTER TABLE `lightning_names` DROP COLUMN `sparkPubKeyHex`;
