CREATE TABLE `conversion_kinds` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`slug` text NOT NULL,
	`label` text NOT NULL,
	`rule_type` text DEFAULT 'manual' NOT NULL,
	`rule_value` text,
	`priority` integer DEFAULT 100 NOT NULL,
	`is_active` integer DEFAULT true NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `conversion_kinds_slug_key` ON `conversion_kinds` (`slug`);--> statement-breakpoint
CREATE INDEX `conversion_kinds_priority_idx` ON `conversion_kinds` (`priority`);--> statement-breakpoint
CREATE TABLE `conversions` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`subscriber_id` integer NOT NULL,
	`kind_id` integer,
	`kind_slug` text NOT NULL,
	`sale_id` integer,
	`value_cents` integer DEFAULT 0 NOT NULL,
	`currency` text DEFAULT 'usd' NOT NULL,
	`message_id` integer,
	`source_kind` text DEFAULT 'direct' NOT NULL,
	`source_id` integer DEFAULT 0 NOT NULL,
	`campaign_id` integer,
	`offer_id` integer,
	`offer_slug` text,
	`attributed_by` text DEFAULT 'none' NOT NULL,
	`touch_lag_seconds` integer,
	`occurred_at` integer NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`subscriber_id`) REFERENCES `subscribers`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`kind_id`) REFERENCES `conversion_kinds`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`sale_id`) REFERENCES `sales`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`message_id`) REFERENCES `messages`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`campaign_id`) REFERENCES `campaigns`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`offer_id`) REFERENCES `offers`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `conversions_sale_key` ON `conversions` (`sale_id`) WHERE sale_id is not null;--> statement-breakpoint
CREATE INDEX `conversions_subscriber_idx` ON `conversions` (`subscriber_id`);--> statement-breakpoint
CREATE INDEX `conversions_message_idx` ON `conversions` (`message_id`);--> statement-breakpoint
CREATE INDEX `conversions_campaign_idx` ON `conversions` (`campaign_id`);--> statement-breakpoint
CREATE INDEX `conversions_offer_idx` ON `conversions` (`offer_slug`);--> statement-breakpoint
CREATE INDEX `conversions_kind_occurred_idx` ON `conversions` (`kind_slug`,`occurred_at`);--> statement-breakpoint
CREATE TABLE `goals` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`kind_id` integer,
	`period_type` text DEFAULT 'year' NOT NULL,
	`period_year` integer NOT NULL,
	`period_index` integer DEFAULT 0 NOT NULL,
	`target_count` integer,
	`target_cents` integer,
	`campaign_id` integer,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`kind_id`) REFERENCES `conversion_kinds`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`campaign_id`) REFERENCES `campaigns`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `goals_period_idx` ON `goals` (`period_year`,`period_type`,`period_index`);