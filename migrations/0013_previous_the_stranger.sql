CREATE TABLE `download_grants` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`form_id` integer NOT NULL,
	`subscriber_id` integer NOT NULL,
	`token` text NOT NULL,
	`download_count` integer DEFAULT 0 NOT NULL,
	`last_downloaded_at` integer,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`form_id`) REFERENCES `forms`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`subscriber_id`) REFERENCES `subscribers`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `download_grants_token_key` ON `download_grants` (`token`);--> statement-breakpoint
CREATE UNIQUE INDEX `download_grants_person_key` ON `download_grants` (`form_id`,`subscriber_id`);--> statement-breakpoint
CREATE INDEX `download_grants_subscriber_idx` ON `download_grants` (`subscriber_id`);--> statement-breakpoint
ALTER TABLE `forms` ADD `download_key` text;--> statement-breakpoint
ALTER TABLE `forms` ADD `download_filename` text;--> statement-breakpoint
ALTER TABLE `forms` ADD `download_content_type` text;--> statement-breakpoint
ALTER TABLE `forms` ADD `download_bytes` integer;--> statement-breakpoint
ALTER TABLE `forms` ADD `download_uploaded_at` integer;--> statement-breakpoint
ALTER TABLE `forms` ADD `delivery_subject` text;--> statement-breakpoint
ALTER TABLE `forms` ADD `delivery_body_json` text;--> statement-breakpoint
ALTER TABLE `forms` ADD `delivery_body_md` text;--> statement-breakpoint
ALTER TABLE `messages` ADD `form_id` integer REFERENCES forms(id);--> statement-breakpoint
ALTER TABLE `messages` ADD `body_json` text;