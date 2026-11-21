CREATE TABLE `onboarding` (
	`id` integer PRIMARY KEY NOT NULL,
	`dismissed_at` integer,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `onboarding_steps` (
	`step` text PRIMARY KEY NOT NULL,
	`outcome` text NOT NULL,
	`decided_at` integer NOT NULL
);
