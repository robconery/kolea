CREATE TABLE `media` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`key` text NOT NULL,
	`filename` text NOT NULL,
	`content_type` text NOT NULL,
	`bytes` integer NOT NULL,
	`width` integer,
	`height` integer,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `media_key_key` ON `media` (`key`);--> statement-breakpoint
CREATE INDEX `media_created_idx` ON `media` (`created_at`);--> statement-breakpoint
ALTER TABLE `broadcasts` ADD `body_json` text;--> statement-breakpoint
ALTER TABLE `sequence_steps` ADD `body_json` text;