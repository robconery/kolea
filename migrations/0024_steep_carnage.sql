CREATE TABLE `broadcast_post_tags` (
	`broadcast_id` integer NOT NULL,
	`post_tag_id` integer NOT NULL,
	`position` integer DEFAULT 0 NOT NULL,
	PRIMARY KEY(`broadcast_id`, `post_tag_id`),
	FOREIGN KEY (`broadcast_id`) REFERENCES `broadcasts`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`post_tag_id`) REFERENCES `post_tags`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `broadcast_post_tags_tag_idx` ON `broadcast_post_tags` (`post_tag_id`);--> statement-breakpoint
CREATE TABLE `post_tags` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`slug` text NOT NULL,
	`name` text NOT NULL,
	`description` text,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `post_tags_slug_key` ON `post_tags` (`slug`);--> statement-breakpoint
CREATE TABLE `theme_files` (
	`theme_id` integer NOT NULL,
	`path` text NOT NULL,
	`body` text NOT NULL,
	PRIMARY KEY(`theme_id`, `path`),
	FOREIGN KEY (`theme_id`) REFERENCES `themes`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `themes` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`version` text DEFAULT '0.0.0' NOT NULL,
	`package_json` text DEFAULT '{}' NOT NULL,
	`settings` text DEFAULT '{}' NOT NULL,
	`is_active` integer DEFAULT false NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `themes_name_key` ON `themes` (`name`);