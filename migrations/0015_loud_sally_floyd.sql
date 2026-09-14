ALTER TABLE `broadcasts` ADD `published_at` integer;--> statement-breakpoint
ALTER TABLE `broadcasts` ADD `slug` text;--> statement-breakpoint
ALTER TABLE `broadcasts` ADD `excerpt` text;--> statement-breakpoint
ALTER TABLE `broadcasts` ADD `feature_image` text;--> statement-breakpoint
ALTER TABLE `broadcasts` ADD `search_text` text;--> statement-breakpoint
CREATE UNIQUE INDEX `broadcasts_slug_key` ON `broadcasts` (`slug`);--> statement-breakpoint
CREATE INDEX `broadcasts_published_at_idx` ON `broadcasts` (`published_at`);