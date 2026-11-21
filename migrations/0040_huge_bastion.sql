CREATE TABLE `webhook_deliveries` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`endpoint_id` integer NOT NULL,
	`event` text NOT NULL,
	`event_id` text NOT NULL,
	`payload` text NOT NULL,
	`occurred_at` integer NOT NULL,
	`dedupe_key` text,
	`status` text DEFAULT 'pending' NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`next_attempt_at` integer,
	`last_attempt_at` integer,
	`last_status_code` integer,
	`last_error` text,
	`last_response` text,
	`delivered_at` integer,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`endpoint_id`) REFERENCES `webhook_endpoints`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `webhook_deliveries_due_idx` ON `webhook_deliveries` (`status`,`next_attempt_at`);--> statement-breakpoint
CREATE INDEX `webhook_deliveries_endpoint_idx` ON `webhook_deliveries` (`endpoint_id`,`created_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `webhook_deliveries_dedupe_key` ON `webhook_deliveries` (`endpoint_id`,`dedupe_key`) WHERE dedupe_key is not null;--> statement-breakpoint
CREATE TABLE `webhook_endpoints` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`url` text NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	`events` text NOT NULL,
	`secret` text NOT NULL,
	`secret_prefix` text NOT NULL,
	`is_active` integer DEFAULT true NOT NULL,
	`disabled_reason` text,
	`disabled_at` integer,
	`consecutive_failures` integer DEFAULT 0 NOT NULL,
	`last_delivered_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
