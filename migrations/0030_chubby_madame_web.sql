CREATE TABLE `form_confirmations` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`form_id` integer NOT NULL,
	`subscriber_id` integer NOT NULL,
	`token` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`created_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	`confirmed_at` integer,
	FOREIGN KEY (`form_id`) REFERENCES `forms`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`subscriber_id`) REFERENCES `subscribers`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `form_confirmations_token_key` ON `form_confirmations` (`token`);--> statement-breakpoint
CREATE INDEX `form_confirmations_person_idx` ON `form_confirmations` (`form_id`,`subscriber_id`);--> statement-breakpoint
CREATE INDEX `form_confirmations_subscriber_idx` ON `form_confirmations` (`subscriber_id`);--> statement-breakpoint
ALTER TABLE `forms` ADD `double_opt_in` integer DEFAULT false NOT NULL;