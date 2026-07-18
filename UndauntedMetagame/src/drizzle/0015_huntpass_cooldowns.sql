CREATE TABLE `cooldowns` (
	`userId` text NOT NULL,
	`cooldownId` text NOT NULL,
	`expiresAt` text NOT NULL,
	`createdDate` text NOT NULL,
	PRIMARY KEY(`userId`, `cooldownId`)
);
--> statement-breakpoint
CREATE TABLE `entitlements` (
	`userId` text NOT NULL,
	`entitlement` text NOT NULL,
	`grantedDate` text NOT NULL,
	`expiresAt` text,
	PRIMARY KEY(`userId`, `entitlement`)
);
