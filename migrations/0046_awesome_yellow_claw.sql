CREATE TABLE `ghostwriter_voices` (
	`id` integer PRIMARY KEY NOT NULL,
	`king` integer DEFAULT 3 NOT NULL,
	`hemingway` integer DEFAULT 2 NOT NULL,
	`vonnegut` integer DEFAULT 0 NOT NULL,
	`didion` integer DEFAULT 0 NOT NULL,
	`bryson` integer DEFAULT 0 NOT NULL,
	`graham` integer DEFAULT 0 NOT NULL,
	`length` text DEFAULT 'medium' NOT NULL,
	`use_my_mail` integer DEFAULT true NOT NULL,
	`structure` text DEFAULT 'punchline' NOT NULL,
	`draft` text DEFAULT 'second' NOT NULL,
	`pitch` text DEFAULT 'cochrane' NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `sequence_take_mails` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`take_id` integer NOT NULL,
	`step_id` integer NOT NULL,
	`position` integer NOT NULL,
	`status` text DEFAULT 'waiting' NOT NULL,
	`plan` text,
	`subject` text,
	`body_md` text,
	`body_json` text,
	`before_subject` text,
	`before_body_md` text,
	`before_body_json` text,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`take_id`) REFERENCES `sequence_takes`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`step_id`) REFERENCES `sequence_steps`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `sequence_take_mails_position_key` ON `sequence_take_mails` (`take_id`,`position`);--> statement-breakpoint
CREATE TABLE `sequence_takes` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`sequence_id` integer NOT NULL,
	`number` integer NOT NULL,
	`status` text DEFAULT 'writing' NOT NULL,
	`draft` text NOT NULL,
	`pitch` text NOT NULL,
	`topic` text NOT NULL,
	`goal` text DEFAULT '' NOT NULL,
	`notes` text DEFAULT '' NOT NULL,
	`story` text,
	`cost_usd` real DEFAULT 0 NOT NULL,
	`failure` text,
	`locked_until` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`sequence_id`) REFERENCES `sequences`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `sequence_takes_number_key` ON `sequence_takes` (`sequence_id`,`number`);--> statement-breakpoint
CREATE INDEX `sequence_takes_status_idx` ON `sequence_takes` (`status`,`created_at`);