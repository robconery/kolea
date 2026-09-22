CREATE TABLE `ai_calls` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`task` text NOT NULL,
	`model` text NOT NULL,
	`prompt_tokens` integer DEFAULT 0 NOT NULL,
	`completion_tokens` integer DEFAULT 0 NOT NULL,
	`cost_usd` real DEFAULT 0 NOT NULL,
	`ok` integer NOT NULL,
	`error` text,
	`duration_ms` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `ai_calls_created_idx` ON `ai_calls` (`created_at`);