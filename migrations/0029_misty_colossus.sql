ALTER TABLE `forms` ADD `download_share_token` text;--> statement-breakpoint
ALTER TABLE `forms` ADD `download_share_count` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `forms` ADD `download_share_last_at` integer;--> statement-breakpoint
CREATE UNIQUE INDEX `forms_download_share_token_key` ON `forms` (`download_share_token`);