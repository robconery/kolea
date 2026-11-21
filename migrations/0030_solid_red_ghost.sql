CREATE TABLE `agent_settings` (
	`id` integer PRIMARY KEY NOT NULL,
	`allow_send` integer DEFAULT false NOT NULL,
	`allow_sensitive` integer DEFAULT false NOT NULL,
	`updated_at` integer NOT NULL
);
