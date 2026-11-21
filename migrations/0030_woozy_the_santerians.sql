CREATE TABLE `sending_domains` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`provider` text NOT NULL,
	`provider_domain_id` text,
	`provider_state` text,
	`provider_records` text DEFAULT '[]' NOT NULL,
	`record_statuses` text DEFAULT '{}' NOT NULL,
	`last_error` text,
	`check_attempt` integer DEFAULT 0 NOT NULL,
	`last_checked_at` integer,
	`next_check_at` integer,
	`verified_at` integer,
	`failed_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `sending_domains_name_key` ON `sending_domains` (`name`);--> statement-breakpoint
CREATE INDEX `sending_domains_next_check_idx` ON `sending_domains` (`next_check_at`);