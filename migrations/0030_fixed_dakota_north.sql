CREATE TABLE `member_sessions` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`subscriber_id` integer NOT NULL,
	`token_hash` text NOT NULL,
	`sign_in_link_id` integer,
	`ip` text,
	`user_agent` text,
	`created_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	`last_seen_at` integer NOT NULL,
	`revoked_at` integer,
	FOREIGN KEY (`subscriber_id`) REFERENCES `subscribers`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`sign_in_link_id`) REFERENCES `member_sign_in_links`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `member_sessions_token_key` ON `member_sessions` (`token_hash`);--> statement-breakpoint
CREATE INDEX `member_sessions_subscriber_idx` ON `member_sessions` (`subscriber_id`);--> statement-breakpoint
CREATE TABLE `member_sign_in_links` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`subscriber_id` integer NOT NULL,
	`status` text DEFAULT 'requested' NOT NULL,
	`token_hash` text,
	`expires_at` integer,
	`message_id` integer,
	`return_post_id` integer,
	`blocked_reason` text,
	`requested_ip` text,
	`requested_user_agent` text,
	`created_at` integer NOT NULL,
	`used_at` integer,
	FOREIGN KEY (`subscriber_id`) REFERENCES `subscribers`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`message_id`) REFERENCES `messages`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`return_post_id`) REFERENCES `broadcasts`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `member_sign_in_links_token_key` ON `member_sign_in_links` (`token_hash`);--> statement-breakpoint
CREATE INDEX `member_sign_in_links_subscriber_idx` ON `member_sign_in_links` (`subscriber_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `member_sign_in_links_ip_idx` ON `member_sign_in_links` (`requested_ip`,`created_at`);--> statement-breakpoint
CREATE TABLE `member_subscriptions` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`subscriber_id` integer NOT NULL,
	`checkout_id` integer,
	`status` text NOT NULL,
	`interval` text NOT NULL,
	`amount_cents` integer NOT NULL,
	`currency` text NOT NULL,
	`stripe_customer_id` text,
	`stripe_subscription_id` text NOT NULL,
	`stripe_price_id` text NOT NULL,
	`converted_from_post_id` integer,
	`current_period_end_at` integer,
	`cancel_at_period_end` integer DEFAULT false NOT NULL,
	`cancel_reason` text,
	`status_changed_at` integer NOT NULL,
	`past_due_at` integer,
	`canceled_at` integer,
	`stripe_event_at` integer,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`subscriber_id`) REFERENCES `subscribers`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`checkout_id`) REFERENCES `premium_checkouts`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`converted_from_post_id`) REFERENCES `broadcasts`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `member_subscriptions_stripe_key` ON `member_subscriptions` (`stripe_subscription_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `member_subscriptions_live_key` ON `member_subscriptions` (`subscriber_id`) WHERE status <> 'canceled';--> statement-breakpoint
CREATE INDEX `member_subscriptions_status_idx` ON `member_subscriptions` (`status`);--> statement-breakpoint
CREATE TABLE `premium_checkouts` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`token` text NOT NULL,
	`interval` text NOT NULL,
	`stripe_price_id` text NOT NULL,
	`subscriber_id` integer,
	`converted_from_post_id` integer,
	`stripe_session_id` text,
	`status` text DEFAULT 'open' NOT NULL,
	`note` text,
	`stripe_subscription_id` text,
	`stripe_customer_id` text,
	`ip` text,
	`user_agent` text,
	`created_at` integer NOT NULL,
	`completed_at` integer,
	FOREIGN KEY (`subscriber_id`) REFERENCES `subscribers`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`converted_from_post_id`) REFERENCES `broadcasts`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `premium_checkouts_token_key` ON `premium_checkouts` (`token`);--> statement-breakpoint
CREATE UNIQUE INDEX `premium_checkouts_session_key` ON `premium_checkouts` (`stripe_session_id`);--> statement-breakpoint
CREATE INDEX `premium_checkouts_ip_idx` ON `premium_checkouts` (`ip`,`created_at`);--> statement-breakpoint
CREATE INDEX `premium_checkouts_status_idx` ON `premium_checkouts` (`status`);--> statement-breakpoint
CREATE TABLE `premium_settings` (
	`id` integer PRIMARY KEY NOT NULL,
	`monthly_price_id` text,
	`yearly_price_id` text,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
ALTER TABLE `broadcasts` ADD `access_level` text DEFAULT 'public' NOT NULL;