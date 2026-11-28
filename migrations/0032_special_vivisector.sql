CREATE TABLE IF NOT EXISTS `link_fixes` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`broadcast_id` integer NOT NULL,
	`from_url` text NOT NULL,
	`to_url` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`broadcast_id`) REFERENCES `broadcasts`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `link_fixes_broadcast_from_key` ON `link_fixes` (`broadcast_id`,`from_url`);