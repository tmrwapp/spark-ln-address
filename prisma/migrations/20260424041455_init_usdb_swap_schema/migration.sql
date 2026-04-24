-- AlterTable
ALTER TABLE `invoices` ADD COLUMN `destinationSparkAddress` VARCHAR(191) NULL,
    ADD COLUMN `receivingCurrency` ENUM('SATS', 'USDB') NOT NULL DEFAULT 'USDB';

-- AlterTable
ALTER TABLE `users` ADD COLUMN `defaultReceivingCurrency` ENUM('SATS', 'USDB') NOT NULL DEFAULT 'USDB';

-- CreateTable
CREATE TABLE `flashnet_orders` (
    `id` VARCHAR(191) NOT NULL,
    `invoiceId` VARCHAR(191) NOT NULL,
    `quoteId` VARCHAR(191) NULL,
    `orderId` VARCHAR(191) NULL,
    `lightningReceiveRequestId` VARCHAR(191) NULL,
    `estimatedOut` DECIMAL(38, 8) NULL,
    `lockedMinAmountOut` DECIMAL(38, 8) NULL,
    `actualOut` DECIMAL(38, 8) NULL,
    `feeAmount` DECIMAL(38, 8) NULL,
    `roundingFeeAmount` DECIMAL(38, 8) NULL,
    `totalFeeAmount` DECIMAL(38, 8) NULL,
    `feeBps` INTEGER NULL,
    `feeAsset` VARCHAR(191) NULL,
    `route` TEXT NULL,
    `priceLockMode` VARCHAR(191) NULL,
    `status` VARCHAR(191) NULL,
    `errorCode` VARCHAR(191) NULL,
    `errorMessage` VARCHAR(191) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `flashnet_orders_invoiceId_key`(`invoiceId`),
    UNIQUE INDEX `flashnet_orders_quoteId_key`(`quoteId`),
    UNIQUE INDEX `flashnet_orders_orderId_key`(`orderId`),
    UNIQUE INDEX `flashnet_orders_lightningReceiveRequestId_key`(`lightningReceiveRequestId`),
    INDEX `flashnet_orders_status_idx`(`status`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `flashnet_webhook_events` (
    `id` VARCHAR(191) NOT NULL,
    `orderId` VARCHAR(191) NOT NULL,
    `event` VARCHAR(191) NOT NULL,
    `timestamp` BIGINT NOT NULL,
    `rawBody` TEXT NOT NULL,
    `signature` VARCHAR(191) NOT NULL,
    `processedAt` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `flashnet_webhook_events_orderId_idx`(`orderId`),
    UNIQUE INDEX `flashnet_webhook_events_orderId_event_timestamp_key`(`orderId`, `event`, `timestamp`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `refund_cases` (
    `id` VARCHAR(191) NOT NULL,
    `invoiceId` VARCHAR(191) NOT NULL,
    `amountSats` INTEGER NOT NULL,
    `reason` VARCHAR(191) NOT NULL,
    `externalRef` VARCHAR(191) NULL,
    `payeeLnAddress` VARCHAR(191) NULL,
    `status` VARCHAR(191) NOT NULL DEFAULT 'OPEN',
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `resolvedAt` DATETIME(3) NULL,

    UNIQUE INDEX `refund_cases_invoiceId_key`(`invoiceId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `flashnet_orders` ADD CONSTRAINT `flashnet_orders_invoiceId_fkey` FOREIGN KEY (`invoiceId`) REFERENCES `invoices`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `refund_cases` ADD CONSTRAINT `refund_cases_invoiceId_fkey` FOREIGN KEY (`invoiceId`) REFERENCES `invoices`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

