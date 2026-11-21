CREATE TABLE `council_audience` (
	`id` integer PRIMARY KEY NOT NULL,
	`field` text DEFAULT 'general' NOT NULL,
	`expertise` text DEFAULT 'practitioner' NOT NULL,
	`purpose` text DEFAULT 'perspective' NOT NULL,
	`attention` text DEFAULT 'reads' NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `council_reviews` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`broadcast_id` integer,
	`sequence_step_id` integer,
	`status` text NOT NULL,
	`draft_subject` text NOT NULL,
	`draft_text` text NOT NULL,
	`audience` text NOT NULL,
	`review` text,
	`resolved` text DEFAULT '{}' NOT NULL,
	`model` text,
	`cost_usd` real DEFAULT 0 NOT NULL,
	`error` text,
	`created_at` integer NOT NULL,
	`finished_at` integer,
	FOREIGN KEY (`broadcast_id`) REFERENCES `broadcasts`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`sequence_step_id`) REFERENCES `sequence_steps`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `council_reviews_broadcast_idx` ON `council_reviews` (`broadcast_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `council_reviews_step_idx` ON `council_reviews` (`sequence_step_id`,`created_at`);