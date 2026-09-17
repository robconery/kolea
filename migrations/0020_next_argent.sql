CREATE TABLE `purchase_templates` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`offer_slug` text NOT NULL,
	`name` text NOT NULL,
	`subject` text NOT NULL,
	`body_json` text,
	`body_md` text,
	`discord_invite_url` text,
	`is_active` integer DEFAULT true NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `purchase_templates_offer_slug_key` ON `purchase_templates` (`offer_slug`);--> statement-breakpoint
ALTER TABLE `messages` ADD `sale_id` integer REFERENCES sales(id) ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE `messages` ADD `extras` text;--> statement-breakpoint
CREATE INDEX `messages_sale_idx` ON `messages` (`sale_id`);