CREATE TABLE `audit_entries` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`at` integer NOT NULL,
	`actor_kind` text NOT NULL,
	`actor_id` text,
	`api_key_id` integer,
	`action` text NOT NULL,
	`target` text,
	`outcome` text NOT NULL,
	`detail` text,
	`status` integer DEFAULT 0 NOT NULL,
	`summary` text DEFAULT '{}' NOT NULL,
	FOREIGN KEY (`api_key_id`) REFERENCES `api_keys`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `audit_entries_at_idx` ON `audit_entries` (`at`);--> statement-breakpoint
CREATE INDEX `audit_entries_outcome_idx` ON `audit_entries` (`outcome`,`at`);--> statement-breakpoint
CREATE INDEX `messages_created_idx` ON `messages` (`created_at`);