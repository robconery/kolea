ALTER TABLE `events` ADD `machine` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `sequences` ADD `send_window_start` integer;--> statement-breakpoint
ALTER TABLE `sequences` ADD `send_window_end` integer;--> statement-breakpoint
ALTER TABLE `site_settings` ADD `time_zone` text;