CREATE TABLE `ai_keys` (
	`provider` text PRIMARY KEY NOT NULL,
	`ciphertext` text NOT NULL,
	`last4` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `ai_settings` (
	`id` integer PRIMARY KEY NOT NULL,
	`payer` text DEFAULT 'env' NOT NULL,
	`models` text DEFAULT '{}' NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
ALTER TABLE `ai_calls` ADD `provider` text DEFAULT 'openrouter' NOT NULL;--> statement-breakpoint
ALTER TABLE `ai_calls` ADD `cost_estimated` integer DEFAULT false NOT NULL;