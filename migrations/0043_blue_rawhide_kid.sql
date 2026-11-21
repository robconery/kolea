CREATE TABLE `import_runs` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`source` text NOT NULL,
	`status` text DEFAULT 'queued' NOT NULL,
	`settings` text DEFAULT '{}' NOT NULL,
	`credentials` text,
	`phase` text,
	`cursor` text,
	`phases_done` integer DEFAULT 0 NOT NULL,
	`phases_total` integer DEFAULT 0 NOT NULL,
	`pages` integer DEFAULT 0 NOT NULL,
	`created` integer DEFAULT 0 NOT NULL,
	`updated` integer DEFAULT 0 NOT NULL,
	`skipped` integer DEFAULT 0 NOT NULL,
	`invalid` integer DEFAULT 0 NOT NULL,
	`detail` text DEFAULT '{}' NOT NULL,
	`notes` text DEFAULT '[]' NOT NULL,
	`last_error` text,
	`failures` integer DEFAULT 0 NOT NULL,
	`locked_until` integer,
	`created_at` integer NOT NULL,
	`started_at` integer,
	`finished_at` integer,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `import_runs_status_idx` ON `import_runs` (`status`,`created_at`);--> statement-breakpoint
ALTER TABLE `broadcasts` ADD `imported_source_id` text;--> statement-breakpoint
CREATE UNIQUE INDEX `broadcasts_imported_source_key` ON `broadcasts` (`imported_from`,`imported_source_id`);--> statement-breakpoint
ALTER TABLE `sequences` ADD `imported_source_id` text;--> statement-breakpoint
CREATE UNIQUE INDEX `sequences_imported_source_key` ON `sequences` (`imported_from`,`imported_source_id`);