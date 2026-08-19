CREATE TABLE `attributions` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`subscriber_id` integer NOT NULL,
	`campaign_id` integer NOT NULL,
	`source_kind` text NOT NULL,
	`source_id` integer DEFAULT 0 NOT NULL,
	`occurred_at` integer NOT NULL,
	FOREIGN KEY (`subscriber_id`) REFERENCES `subscribers`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`campaign_id`) REFERENCES `campaigns`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `attributions_touch_key` ON `attributions` (`subscriber_id`,`campaign_id`,`source_kind`,`source_id`);--> statement-breakpoint
CREATE INDEX `attributions_subscriber_idx` ON `attributions` (`subscriber_id`,`occurred_at`);--> statement-breakpoint
CREATE INDEX `attributions_campaign_idx` ON `attributions` (`campaign_id`);--> statement-breakpoint
CREATE TABLE `campaigns` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`slug` text NOT NULL,
	`name` text NOT NULL,
	`description` text,
	`status` text DEFAULT 'active' NOT NULL,
	`goal_cents` integer,
	`started_at` integer,
	`ended_at` integer,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `campaigns_slug_key` ON `campaigns` (`slug`);--> statement-breakpoint
CREATE TABLE `form_tags` (
	`form_id` integer NOT NULL,
	`tag_id` integer NOT NULL,
	PRIMARY KEY(`form_id`, `tag_id`),
	FOREIGN KEY (`form_id`) REFERENCES `forms`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`tag_id`) REFERENCES `tags`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `forms` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`slug` text NOT NULL,
	`name` text NOT NULL,
	`sequence_id` integer,
	`campaign_id` integer,
	`redirect_url` text,
	`success_message` text DEFAULT 'You''re subscribed. Thanks!' NOT NULL,
	`is_active` integer DEFAULT true NOT NULL,
	`submit_count` integer DEFAULT 0 NOT NULL,
	`last_submitted_at` integer,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`sequence_id`) REFERENCES `sequences`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`campaign_id`) REFERENCES `campaigns`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `forms_slug_key` ON `forms` (`slug`);--> statement-breakpoint
CREATE TABLE `sales` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`subscriber_id` integer NOT NULL,
	`campaign_id` integer,
	`product` text,
	`amount_cents` integer NOT NULL,
	`currency` text DEFAULT 'usd' NOT NULL,
	`status` text DEFAULT 'paid' NOT NULL,
	`external_id` text,
	`meta` text DEFAULT '{}' NOT NULL,
	`occurred_at` integer NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`subscriber_id`) REFERENCES `subscribers`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`campaign_id`) REFERENCES `campaigns`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `sales_external_id_key` ON `sales` (`external_id`) WHERE external_id is not null;--> statement-breakpoint
CREATE INDEX `sales_subscriber_idx` ON `sales` (`subscriber_id`);--> statement-breakpoint
CREATE INDEX `sales_campaign_idx` ON `sales` (`campaign_id`,`status`);--> statement-breakpoint
CREATE INDEX `sales_occurred_idx` ON `sales` (`occurred_at`);--> statement-breakpoint
-- ON DELETE SET NULL added by hand, same as 0004: drizzle-kit omits it from
-- ALTER ... ADD COLUMN, and without it deleting a campaign would fail once a
-- broadcast or sequence referenced it.
ALTER TABLE `broadcasts` ADD `campaign_id` integer REFERENCES campaigns(id) ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE `sequences` ADD `campaign_id` integer REFERENCES campaigns(id) ON DELETE SET NULL;