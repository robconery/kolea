CREATE TABLE `sequence_templates` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`slug` text NOT NULL,
	`name` text NOT NULL,
	`family` text DEFAULT 'funnel' NOT NULL,
	`source` text DEFAULT '' NOT NULL,
	`tagline` text DEFAULT '' NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	`best_for` text DEFAULT '[]' NOT NULL,
	`needs` text DEFAULT '[]' NOT NULL,
	`suggested_trigger` text DEFAULT 'manual' NOT NULL,
	`trigger_hint` text DEFAULT '' NOT NULL,
	`default_name` text DEFAULT '' NOT NULL,
	`default_description` text DEFAULT '' NOT NULL,
	`steps` text DEFAULT '[]' NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `sequence_templates_slug_key` ON `sequence_templates` (`slug`);