CREATE TABLE `sale_items` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`sale_id` integer NOT NULL,
	`stripe_product_id` text,
	`stripe_price_id` text,
	`description` text NOT NULL,
	`quantity` integer DEFAULT 1 NOT NULL,
	`amount_cents` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`sale_id`) REFERENCES `sales`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `sale_items_sale_price_key` ON `sale_items` (`sale_id`,`stripe_price_id`) WHERE stripe_price_id is not null;--> statement-breakpoint
CREATE INDEX `sale_items_sale_idx` ON `sale_items` (`sale_id`);--> statement-breakpoint
CREATE INDEX `sale_items_product_idx` ON `sale_items` (`stripe_product_id`);--> statement-breakpoint
CREATE TABLE `stripe_events` (
	`id` text PRIMARY KEY NOT NULL,
	`type` text NOT NULL,
	`status` text DEFAULT 'received' NOT NULL,
	`note` text,
	`object_id` text,
	`sale_id` integer,
	`received_at` integer NOT NULL,
	`processed_at` integer,
	FOREIGN KEY (`sale_id`) REFERENCES `sales`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `stripe_events_type_idx` ON `stripe_events` (`type`,`received_at`);--> statement-breakpoint
CREATE INDEX `stripe_events_status_idx` ON `stripe_events` (`status`);--> statement-breakpoint
CREATE INDEX `stripe_events_object_idx` ON `stripe_events` (`object_id`);--> statement-breakpoint
CREATE TABLE `stripe_prices` (
	`id` text PRIMARY KEY NOT NULL,
	`product_id` text NOT NULL,
	`nickname` text,
	`unit_amount` integer,
	`currency` text DEFAULT 'usd' NOT NULL,
	`interval` text DEFAULT 'one_time' NOT NULL,
	`interval_count` integer DEFAULT 1 NOT NULL,
	`active` integer DEFAULT true NOT NULL,
	`metadata` text DEFAULT '{}' NOT NULL,
	`synced_at` integer NOT NULL,
	FOREIGN KEY (`product_id`) REFERENCES `stripe_products`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `stripe_prices_product_idx` ON `stripe_prices` (`product_id`);--> statement-breakpoint
CREATE INDEX `stripe_prices_active_idx` ON `stripe_prices` (`active`);--> statement-breakpoint
CREATE TABLE `stripe_products` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`description` text,
	`active` integer DEFAULT true NOT NULL,
	`default_price_id` text,
	`metadata` text DEFAULT '{}' NOT NULL,
	`stripe_updated` integer,
	`synced_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `stripe_products_active_idx` ON `stripe_products` (`active`);