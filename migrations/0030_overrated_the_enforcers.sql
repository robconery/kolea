CREATE TABLE `oauth_clients` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`client_id` text NOT NULL,
	`client_name` text NOT NULL,
	`redirect_uris` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `oauth_clients_client_id_key` ON `oauth_clients` (`client_id`);--> statement-breakpoint
CREATE TABLE `oauth_codes` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`code_hash` text NOT NULL,
	`client_id` integer NOT NULL,
	`redirect_uri` text NOT NULL,
	`code_challenge` text NOT NULL,
	`access` text NOT NULL,
	`approved_by` text,
	`expires_at` integer NOT NULL,
	`used_at` integer,
	`grant_id` integer,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`client_id`) REFERENCES `oauth_clients`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`grant_id`) REFERENCES `oauth_grants`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `oauth_codes_hash_key` ON `oauth_codes` (`code_hash`);--> statement-breakpoint
CREATE TABLE `oauth_grants` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`client_id` integer NOT NULL,
	`access` text DEFAULT 'read' NOT NULL,
	`redirect_uri` text NOT NULL,
	`approved_by` text,
	`created_at` integer NOT NULL,
	`last_used_at` integer,
	`revoked_at` integer,
	FOREIGN KEY (`client_id`) REFERENCES `oauth_clients`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `oauth_grants_client_idx` ON `oauth_grants` (`client_id`);--> statement-breakpoint
CREATE TABLE `oauth_tokens` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`grant_id` integer NOT NULL,
	`kind` text NOT NULL,
	`token_hash` text NOT NULL,
	`expires_at` integer NOT NULL,
	`used_at` integer,
	`revoked_at` integer,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`grant_id`) REFERENCES `oauth_grants`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `oauth_tokens_hash_key` ON `oauth_tokens` (`token_hash`);--> statement-breakpoint
CREATE INDEX `oauth_tokens_grant_idx` ON `oauth_tokens` (`grant_id`);--> statement-breakpoint
ALTER TABLE `mcp_calls` ADD `oauth_grant_id` integer REFERENCES oauth_grants(id);