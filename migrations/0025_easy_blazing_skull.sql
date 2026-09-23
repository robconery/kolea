CREATE TABLE `site_settings` (
	`id` integer PRIMARY KEY NOT NULL,
	`title` text,
	`tagline` text,
	`logo_url` text,
	`social_links` text DEFAULT '[]' NOT NULL,
	`author_name` text,
	`author_photo_url` text,
	`short_bio` text,
	`long_bio_json` text,
	`long_bio_md` text,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
ALTER TABLE `broadcasts` ADD `featured` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `post_tags` ADD `show_on_home` integer DEFAULT false NOT NULL;