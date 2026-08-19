CREATE TABLE `mcp_calls` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`tool` text NOT NULL,
	`api_key_id` integer,
	`args` text DEFAULT '{}' NOT NULL,
	`outcome` text NOT NULL,
	`detail` text,
	`duration_ms` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`api_key_id`) REFERENCES `api_keys`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `mcp_calls_created_idx` ON `mcp_calls` (`created_at`);--> statement-breakpoint
CREATE INDEX `mcp_calls_tool_idx` ON `mcp_calls` (`tool`);--> statement-breakpoint
CREATE TABLE `preflight_tokens` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`token_hash` text NOT NULL,
	`kind` text NOT NULL,
	`target_id` integer NOT NULL,
	`digest` text NOT NULL,
	`recipient_count` integer DEFAULT 0 NOT NULL,
	`expires_at` integer NOT NULL,
	`used_at` integer,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `preflight_tokens_hash_key` ON `preflight_tokens` (`token_hash`);--> statement-breakpoint
CREATE TABLE `sync_runs` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`kind` text NOT NULL,
	`trigger` text NOT NULL,
	`status` text DEFAULT 'running' NOT NULL,
	`charges_seen` integer DEFAULT 0 NOT NULL,
	`sales_recorded` integer DEFAULT 0 NOT NULL,
	`refunds_applied` integer DEFAULT 0 NOT NULL,
	`duplicates` integer DEFAULT 0 NOT NULL,
	`unattributed` integer DEFAULT 0 NOT NULL,
	`notes` text DEFAULT '[]' NOT NULL,
	`cursor` integer,
	`started_at` integer NOT NULL,
	`finished_at` integer
);
--> statement-breakpoint
CREATE INDEX `sync_runs_kind_started_idx` ON `sync_runs` (`kind`,`started_at`);--> statement-breakpoint
ALTER TABLE `api_keys` ADD `scope` text DEFAULT 'send' NOT NULL;