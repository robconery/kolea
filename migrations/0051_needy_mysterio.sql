CREATE TABLE `api_rate_windows` (
	`api_key_id` integer NOT NULL,
	`minute` integer NOT NULL,
	`count` integer DEFAULT 0 NOT NULL,
	PRIMARY KEY(`api_key_id`, `minute`),
	FOREIGN KEY (`api_key_id`) REFERENCES `api_keys`(`id`) ON UPDATE no action ON DELETE cascade
);
