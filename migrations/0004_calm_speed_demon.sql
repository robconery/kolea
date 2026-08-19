CREATE TABLE `segments` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`slug` text NOT NULL,
	`name` text NOT NULL,
	`rule` text DEFAULT '{}' NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `segments_slug_key` ON `segments` (`slug`);--> statement-breakpoint
CREATE TABLE `tag_rules` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`event` text NOT NULL,
	`broadcast_id` integer,
	`sequence_id` integer,
	`url_contains` text,
	`tag_id` integer NOT NULL,
	`is_active` integer DEFAULT true NOT NULL,
	`applied_count` integer DEFAULT 0 NOT NULL,
	`last_applied_at` integer,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`broadcast_id`) REFERENCES `broadcasts`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`sequence_id`) REFERENCES `sequences`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`tag_id`) REFERENCES `tags`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `tag_rules_active_event_idx` ON `tag_rules` (`is_active`,`event`);--> statement-breakpoint
-- ON DELETE SET NULL added by hand: drizzle-kit omits it from ALTER ... ADD COLUMN,
-- and without it deleting a segment would fail once a broadcast referenced it.
-- SQLite allows an FK clause here because the column defaults to NULL.
ALTER TABLE `broadcasts` ADD `segment_id` integer REFERENCES segments(id) ON DELETE SET NULL;