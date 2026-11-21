CREATE TABLE `launches` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`slug` text NOT NULL,
	`name` text NOT NULL,
	`step` text DEFAULT 'offer' NOT NULL,
	`status` text DEFAULT 'draft' NOT NULL,
	`offer` text,
	`audience` text,
	`problem` text,
	`promise` text,
	`story` text,
	`objections` text,
	`price_note` text,
	`store_offer_id` integer,
	`template_slug` text,
	`starts_on` integer,
	`campaign_id` integer,
	`sequence_id` integer,
	`trigger_tag_id` integer,
	`outline` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`handed_off_at` integer,
	`closed_at` integer,
	FOREIGN KEY (`store_offer_id`) REFERENCES `store_offers`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`campaign_id`) REFERENCES `campaigns`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`sequence_id`) REFERENCES `sequences`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`trigger_tag_id`) REFERENCES `tags`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `launches_slug_key` ON `launches` (`slug`);--> statement-breakpoint
CREATE INDEX `launches_status_idx` ON `launches` (`status`);