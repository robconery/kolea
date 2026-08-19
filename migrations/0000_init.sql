CREATE TABLE `api_keys` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`token_hash` text NOT NULL,
	`created_at` integer NOT NULL,
	`last_used_at` integer,
	`revoked_at` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `api_keys_token_hash_key` ON `api_keys` (`token_hash`);--> statement-breakpoint
CREATE TABLE `broadcasts` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`subject` text NOT NULL,
	`body_md` text NOT NULL,
	`segment` text DEFAULT '{}' NOT NULL,
	`status` text DEFAULT 'draft' NOT NULL,
	`scheduled_at` integer,
	`started_at` integer,
	`sent_at` integer,
	`cursor_subscriber_id` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `broadcasts_status_scheduled_idx` ON `broadcasts` (`status`,`scheduled_at`);--> statement-breakpoint
CREATE TABLE `dev_outbox` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`message_id` integer NOT NULL,
	`to_email` text NOT NULL,
	`from_email` text NOT NULL,
	`subject` text NOT NULL,
	`html` text NOT NULL,
	`text` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`message_id`) REFERENCES `messages`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `dev_outbox_created_idx` ON `dev_outbox` (`created_at`);--> statement-breakpoint
CREATE TABLE `events` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`message_id` integer NOT NULL,
	`type` text NOT NULL,
	`occurred_at` integer NOT NULL,
	`meta` text DEFAULT '{}' NOT NULL,
	`dedupe_key` text,
	FOREIGN KEY (`message_id`) REFERENCES `messages`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `events_message_type_idx` ON `events` (`message_id`,`type`);--> statement-breakpoint
CREATE UNIQUE INDEX `events_dedupe_key` ON `events` (`dedupe_key`) WHERE dedupe_key is not null;--> statement-breakpoint
CREATE TABLE `messages` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`subscriber_id` integer NOT NULL,
	`kind` text NOT NULL,
	`broadcast_id` integer,
	`sequence_step_id` integer,
	`to_email` text NOT NULL,
	`subject` text NOT NULL,
	`body_md` text,
	`status` text DEFAULT 'queued' NOT NULL,
	`suppressed_reason` text,
	`provider` text,
	`provider_message_id` text,
	`idempotency_key` text,
	`error` text,
	`created_at` integer NOT NULL,
	`sent_at` integer,
	FOREIGN KEY (`subscriber_id`) REFERENCES `subscribers`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`broadcast_id`) REFERENCES `broadcasts`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`sequence_step_id`) REFERENCES `sequence_steps`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `messages_broadcast_idx` ON `messages` (`broadcast_id`);--> statement-breakpoint
CREATE INDEX `messages_subscriber_idx` ON `messages` (`subscriber_id`);--> statement-breakpoint
CREATE INDEX `messages_status_idx` ON `messages` (`status`);--> statement-breakpoint
CREATE UNIQUE INDEX `messages_idempotency_key` ON `messages` (`idempotency_key`) WHERE idempotency_key is not null;--> statement-breakpoint
CREATE TABLE `sequence_enrollments` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`sequence_id` integer NOT NULL,
	`subscriber_id` integer NOT NULL,
	`next_step_id` integer,
	`status` text DEFAULT 'active' NOT NULL,
	`next_run_at` integer,
	`enrolled_at` integer NOT NULL,
	FOREIGN KEY (`sequence_id`) REFERENCES `sequences`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`subscriber_id`) REFERENCES `subscribers`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`next_step_id`) REFERENCES `sequence_steps`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `sequence_enrollments_key` ON `sequence_enrollments` (`sequence_id`,`subscriber_id`);--> statement-breakpoint
CREATE INDEX `sequence_enrollments_due_idx` ON `sequence_enrollments` (`status`,`next_run_at`);--> statement-breakpoint
CREATE TABLE `sequence_optouts` (
	`subscriber_id` integer NOT NULL,
	`sequence_id` integer NOT NULL,
	`opted_out_at` integer NOT NULL,
	PRIMARY KEY(`subscriber_id`, `sequence_id`),
	FOREIGN KEY (`subscriber_id`) REFERENCES `subscribers`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`sequence_id`) REFERENCES `sequences`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `sequence_steps` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`sequence_id` integer NOT NULL,
	`position` integer NOT NULL,
	`delay_minutes` integer DEFAULT 0 NOT NULL,
	`subject` text NOT NULL,
	`body_md` text NOT NULL,
	FOREIGN KEY (`sequence_id`) REFERENCES `sequences`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `sequence_steps_order_key` ON `sequence_steps` (`sequence_id`,`position`);--> statement-breakpoint
CREATE TABLE `sequences` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`slug` text NOT NULL,
	`name` text NOT NULL,
	`description` text,
	`trigger` text NOT NULL,
	`trigger_tag_id` integer,
	`is_active` integer DEFAULT false NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`trigger_tag_id`) REFERENCES `tags`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `sequences_slug_key` ON `sequences` (`slug`);--> statement-breakpoint
CREATE TABLE `subscriber_tags` (
	`subscriber_id` integer NOT NULL,
	`tag_id` integer NOT NULL,
	`tagged_at` integer NOT NULL,
	PRIMARY KEY(`subscriber_id`, `tag_id`),
	FOREIGN KEY (`subscriber_id`) REFERENCES `subscribers`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`tag_id`) REFERENCES `tags`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `subscribers` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`email` text NOT NULL,
	`name` text,
	`status` text DEFAULT 'active' NOT NULL,
	`attributes` text DEFAULT '{}' NOT NULL,
	`source` text,
	`unsub_token` text NOT NULL,
	`created_at` integer NOT NULL,
	`confirmed_at` integer,
	`unsubscribed_at` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `subscribers_email_key` ON `subscribers` (`email`);--> statement-breakpoint
CREATE UNIQUE INDEX `subscribers_unsub_token_key` ON `subscribers` (`unsub_token`);--> statement-breakpoint
CREATE INDEX `subscribers_status_idx` ON `subscribers` (`status`);--> statement-breakpoint
CREATE TABLE `suppressions` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`email` text NOT NULL,
	`reason` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `suppressions_email_key` ON `suppressions` (`email`);--> statement-breakpoint
CREATE TABLE `tags` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`slug` text NOT NULL,
	`name` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `tags_slug_key` ON `tags` (`slug`);