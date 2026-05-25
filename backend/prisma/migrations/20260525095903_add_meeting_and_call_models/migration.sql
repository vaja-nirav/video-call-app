-- AlterTable
ALTER TABLE `user` ADD COLUMN `refreshToken` VARCHAR(500) NULL;

-- CreateTable
CREATE TABLE `Meeting` (
    `id` VARCHAR(191) NOT NULL,
    `title` VARCHAR(100) NULL,
    `hostId` INTEGER NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `endedAt` DATETIME(3) NULL,

    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `Participant` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `meetingId` VARCHAR(191) NOT NULL,
    `userId` INTEGER NULL,
    `guestName` VARCHAR(100) NULL,
    `role` VARCHAR(191) NOT NULL DEFAULT 'PARTICIPANT',
    `isMuted` BOOLEAN NOT NULL DEFAULT false,
    `isCameraOff` BOOLEAN NOT NULL DEFAULT false,
    `isHandRaised` BOOLEAN NOT NULL DEFAULT false,
    `joinedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `leftAt` DATETIME(3) NULL,

    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `Message` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `meetingId` VARCHAR(191) NOT NULL,
    `userId` INTEGER NULL,
    `senderName` VARCHAR(100) NOT NULL,
    `content` TEXT NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `CallLog` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `meetingId` VARCHAR(191) NOT NULL,
    `userId` INTEGER NULL,
    `action` VARCHAR(50) NOT NULL,
    `details` VARCHAR(255) NULL,
    `timestamp` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `Meeting` ADD CONSTRAINT `Meeting_hostId_fkey` FOREIGN KEY (`hostId`) REFERENCES `User`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `Participant` ADD CONSTRAINT `Participant_meetingId_fkey` FOREIGN KEY (`meetingId`) REFERENCES `Meeting`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `Participant` ADD CONSTRAINT `Participant_userId_fkey` FOREIGN KEY (`userId`) REFERENCES `User`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `Message` ADD CONSTRAINT `Message_meetingId_fkey` FOREIGN KEY (`meetingId`) REFERENCES `Meeting`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `Message` ADD CONSTRAINT `Message_userId_fkey` FOREIGN KEY (`userId`) REFERENCES `User`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `CallLog` ADD CONSTRAINT `CallLog_meetingId_fkey` FOREIGN KEY (`meetingId`) REFERENCES `Meeting`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `CallLog` ADD CONSTRAINT `CallLog_userId_fkey` FOREIGN KEY (`userId`) REFERENCES `User`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
