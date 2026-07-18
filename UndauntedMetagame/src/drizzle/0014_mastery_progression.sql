CREATE TABLE `progressiontracks` (
	`userId` text NOT NULL,
	`progressionId` text NOT NULL,
	`progress` integer NOT NULL DEFAULT 0,
	`confirmedFreemiumRank` integer NOT NULL DEFAULT 0,
	`confirmedPremiumRank` integer NOT NULL DEFAULT 0,
	`confirmedDate` text,
	`lastModifiedDate` text NOT NULL,
	PRIMARY KEY(`userId`, `progressionId`)
);
--> statement-breakpoint
CREATE TABLE `progressionobjectives` (
	`userId` text NOT NULL,
	`objectiveId` text NOT NULL,
	`progress` integer NOT NULL DEFAULT 0,
	`completedCount` integer NOT NULL DEFAULT 0,
	`createdDate` text NOT NULL,
	`lastModifiedDate` text NOT NULL,
	PRIMARY KEY(`userId`, `objectiveId`)
);
--> statement-breakpoint
CREATE TABLE `progressionreceipts` (
	`userId` text NOT NULL,
	`fingerprint` text NOT NULL,
	`response` text NOT NULL,
	`createdDate` text NOT NULL,
	PRIMARY KEY(`userId`, `fingerprint`)
);
