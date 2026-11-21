CREATE TABLE `team_members` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`email` text NOT NULL,
	`role` text NOT NULL,
	`invited_at` integer NOT NULL,
	`joined_at` integer,
	`removed_at` integer,
	`invited_by` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `team_members_email_idx` ON `team_members` (`email`);--> statement-breakpoint
ALTER TABLE `audit_entries` ADD `actor_role` text;