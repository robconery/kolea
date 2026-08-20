CREATE TABLE `offer_products` (
	`offer_id` integer NOT NULL,
	`product_sku` text NOT NULL,
	`product_name` text NOT NULL,
	PRIMARY KEY(`offer_id`, `product_sku`),
	FOREIGN KEY (`offer_id`) REFERENCES `offers`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `offer_products_sku_idx` ON `offer_products` (`product_sku`);--> statement-breakpoint
CREATE TABLE `offers` (
	`id` integer PRIMARY KEY NOT NULL,
	`slug` text NOT NULL,
	`title` text NOT NULL,
	`price_cents` integer,
	`active` integer DEFAULT false NOT NULL,
	`sort_order` integer DEFAULT 0 NOT NULL,
	`synced_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `offers_slug_key` ON `offers` (`slug`);--> statement-breakpoint
CREATE INDEX `offers_active_idx` ON `offers` (`active`);--> statement-breakpoint
CREATE TABLE `purchase_stats` (
	`email` text PRIMARY KEY NOT NULL,
	`order_count` integer DEFAULT 0 NOT NULL,
	`lifetime_cents` integer DEFAULT 0 NOT NULL,
	`confident_cents` integer DEFAULT 0 NOT NULL,
	`first_at` integer,
	`last_at` integer,
	`computed_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `purchase_stats_lifetime_idx` ON `purchase_stats` (`lifetime_cents`);--> statement-breakpoint
CREATE INDEX `purchase_stats_last_idx` ON `purchase_stats` (`last_at`);--> statement-breakpoint
CREATE TABLE `purchases` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`email` text NOT NULL,
	`external_id` text NOT NULL,
	`offer_id` integer,
	`offer_slug` text,
	`store` text NOT NULL,
	`amount_cents` integer DEFAULT 0 NOT NULL,
	`currency` text DEFAULT 'usd' NOT NULL,
	`confidence` text DEFAULT 'high' NOT NULL,
	`occurred_at` integer NOT NULL,
	`synced_at` integer NOT NULL,
	FOREIGN KEY (`offer_id`) REFERENCES `offers`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `purchases_external_id_key` ON `purchases` (`external_id`);--> statement-breakpoint
CREATE INDEX `purchases_email_idx` ON `purchases` (`email`);--> statement-breakpoint
CREATE INDEX `purchases_offer_slug_idx` ON `purchases` (`offer_slug`);--> statement-breakpoint
CREATE INDEX `purchases_occurred_idx` ON `purchases` (`occurred_at`);