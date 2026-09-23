CREATE TABLE `page_views` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`view_key` text NOT NULL,
	`day` text NOT NULL,
	`occurred_at` integer NOT NULL,
	`path` text NOT NULL,
	`broadcast_id` integer,
	`referrer` text,
	`referrer_host` text,
	`source` text,
	`country` text,
	`visitor` text,
	`seconds` integer,
	FOREIGN KEY (`broadcast_id`) REFERENCES `broadcasts`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `page_views_view_key` ON `page_views` (`view_key`);--> statement-breakpoint
CREATE INDEX `page_views_day_idx` ON `page_views` (`day`);--> statement-breakpoint
CREATE INDEX `page_views_broadcast_idx` ON `page_views` (`broadcast_id`);--> statement-breakpoint
CREATE INDEX `page_views_occurred_idx` ON `page_views` (`occurred_at`);