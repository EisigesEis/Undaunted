CREATE TABLE IF NOT EXISTS `escalationprogression` (
	`userId` text NOT NULL,
	`escalationSeason` text NOT NULL,
	`escalationLevel` integer NOT NULL,
	`nextLevelXp` integer NOT NULL,
	`talentsProgress` text NOT NULL,
	`unlockProgress` text NOT NULL,
	`updateVersion` integer NOT NULL,
	`lastModifiedDate` text NOT NULL,
	PRIMARY KEY(`userId`, `escalationSeason`)
);
