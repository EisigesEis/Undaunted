CREATE INDEX `gameserverapikeys_keyHash_idx` ON `gameserverapikeys` (`keyHash`);--> statement-breakpoint
CREATE INDEX `userapikeys_keyHash_idx` ON `userapikeys` (`keyHash`);--> statement-breakpoint
CREATE TABLE `userrefreshtokens` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`userId` text NOT NULL,
	`tokenHash` text NOT NULL,
	`issuedAt` text NOT NULL,
	`expiresAt` text NOT NULL,
	`revokedAt` text,
	`replacedByTokenHash` text
);
--> statement-breakpoint
CREATE INDEX `userrefreshtokens_tokenHash_idx` ON `userrefreshtokens` (`tokenHash`);--> statement-breakpoint
CREATE INDEX `userrefreshtokens_userId_idx` ON `userrefreshtokens` (`userId`);
