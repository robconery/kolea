CREATE TABLE `sequence_exits` (
	`sequence_id` integer NOT NULL,
	`tag_id` integer NOT NULL,
	`then_sequence_id` integer,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`sequence_id`, `tag_id`),
	FOREIGN KEY (`sequence_id`) REFERENCES `sequences`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`tag_id`) REFERENCES `tags`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`then_sequence_id`) REFERENCES `sequences`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `sequence_exits_tag_idx` ON `sequence_exits` (`tag_id`);--> statement-breakpoint
ALTER TABLE `sequences` ADD `next_sequence_id` integer REFERENCES sequences(id);