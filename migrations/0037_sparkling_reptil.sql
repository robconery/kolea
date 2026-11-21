CREATE TABLE `list_prunes` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`groups` text NOT NULL,
	`inactive_days` integer NOT NULL,
	`subscriber_ids` text NOT NULL,
	`planned` text NOT NULL,
	`total` integer NOT NULL,
	`position` integer DEFAULT 0 NOT NULL,
	`deleted` integer DEFAULT 0 NOT NULL,
	`deleted_by_group` text DEFAULT '{}' NOT NULL,
	`skipped` integer DEFAULT 0 NOT NULL,
	`status` text DEFAULT 'planned' NOT NULL,
	`backed_up_at` integer,
	`created_at` integer NOT NULL,
	`confirmed_at` integer,
	`finished_at` integer
);
--> statement-breakpoint
CREATE INDEX `list_prunes_created_idx` ON `list_prunes` (`created_at`);