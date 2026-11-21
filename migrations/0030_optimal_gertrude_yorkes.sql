CREATE TABLE `transactional_templates` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`slug` text NOT NULL,
	`name` text NOT NULL,
	`subject` text NOT NULL,
	`body_json` text,
	`body_md` text,
	`is_active` integer DEFAULT true NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `transactional_templates_slug_key` ON `transactional_templates` (`slug`);--> statement-breakpoint
ALTER TABLE `messages` ADD `template_slug` text;--> statement-breakpoint
CREATE INDEX `messages_template_slug_idx` ON `messages` (`template_slug`) WHERE template_slug is not null;