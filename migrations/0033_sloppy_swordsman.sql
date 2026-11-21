CREATE TABLE `store_checkouts` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`token` text NOT NULL,
	`stripe_price_id` text NOT NULL,
	`stripe_product_id` text NOT NULL,
	`offer_slug` text NOT NULL,
	`amount_cents` integer NOT NULL,
	`currency` text NOT NULL,
	`converted_from_broadcast_id` integer,
	`subscriber_id` integer,
	`sale_id` integer,
	`status` text DEFAULT 'started' NOT NULL,
	`stripe_session_id` text,
	`last_error` text,
	`ip` text,
	`user_agent` text,
	`created_at` integer NOT NULL,
	`completed_at` integer,
	FOREIGN KEY (`converted_from_broadcast_id`) REFERENCES `broadcasts`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`subscriber_id`) REFERENCES `subscribers`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`sale_id`) REFERENCES `sales`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `store_checkouts_token_key` ON `store_checkouts` (`token`);--> statement-breakpoint
CREATE INDEX `store_checkouts_ip_idx` ON `store_checkouts` (`ip`,`created_at`);--> statement-breakpoint
CREATE INDEX `store_checkouts_broadcast_idx` ON `store_checkouts` (`converted_from_broadcast_id`);--> statement-breakpoint
CREATE INDEX `store_checkouts_sale_idx` ON `store_checkouts` (`sale_id`);--> statement-breakpoint
CREATE TABLE `store_offers` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`product_id` text NOT NULL,
	`price_id` text NOT NULL,
	`slug` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`product_id`) REFERENCES `stripe_products`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`price_id`) REFERENCES `stripe_prices`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `store_offers_product_key` ON `store_offers` (`product_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `store_offers_slug_key` ON `store_offers` (`slug`);