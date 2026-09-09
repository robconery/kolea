CREATE TABLE `activities` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`subscriber_id` integer NOT NULL,
	`type` text NOT NULL,
	`occurred_at` integer NOT NULL,
	`campaign_id` integer,
	`sequence_id` integer,
	`source` text DEFAULT 'system' NOT NULL,
	`meta` text DEFAULT '{}' NOT NULL,
	`dedupe_key` text,
	FOREIGN KEY (`subscriber_id`) REFERENCES `subscribers`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`campaign_id`) REFERENCES `campaigns`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`sequence_id`) REFERENCES `sequences`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `activities_subscriber_idx` ON `activities` (`subscriber_id`,`occurred_at`);--> statement-breakpoint
CREATE INDEX `activities_occurred_idx` ON `activities` (`occurred_at`);--> statement-breakpoint
CREATE INDEX `activities_type_idx` ON `activities` (`type`,`occurred_at`);--> statement-breakpoint
CREATE INDEX `activities_sequence_idx` ON `activities` (`sequence_id`,`type`);--> statement-breakpoint
CREATE UNIQUE INDEX `activities_dedupe_key` ON `activities` (`dedupe_key`) WHERE dedupe_key is not null;