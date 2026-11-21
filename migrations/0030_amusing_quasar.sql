CREATE TABLE `agent_settings` (
	`id` integer PRIMARY KEY NOT NULL,
	`allow_send` integer DEFAULT false NOT NULL,
	`allow_sensitive` integer DEFAULT false NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
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
CREATE TABLE `api_rate_windows` (
	`api_key_id` integer NOT NULL,
	`minute` integer NOT NULL,
	`count` integer DEFAULT 0 NOT NULL,
	PRIMARY KEY(`api_key_id`, `minute`),
	FOREIGN KEY (`api_key_id`) REFERENCES `api_keys`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `audit_entries` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`at` integer NOT NULL,
	`actor_kind` text NOT NULL,
	`actor_id` text,
	`api_key_id` integer,
	`action` text NOT NULL,
	`target` text,
	`outcome` text NOT NULL,
	`detail` text,
	`status` integer DEFAULT 0 NOT NULL,
	`summary` text DEFAULT '{}' NOT NULL,
	`actor_role` text,
	FOREIGN KEY (`api_key_id`) REFERENCES `api_keys`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `audit_entries_at_idx` ON `audit_entries` (`at`);--> statement-breakpoint
CREATE INDEX `audit_entries_outcome_idx` ON `audit_entries` (`outcome`,`at`);--> statement-breakpoint
CREATE TABLE `council_audience` (
	`id` integer PRIMARY KEY NOT NULL,
	`field` text DEFAULT 'general' NOT NULL,
	`expertise` text DEFAULT 'practitioner' NOT NULL,
	`purpose` text DEFAULT 'perspective' NOT NULL,
	`attention` text DEFAULT 'reads' NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `council_reviews` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`broadcast_id` integer,
	`sequence_step_id` integer,
	`status` text NOT NULL,
	`draft_subject` text NOT NULL,
	`draft_text` text NOT NULL,
	`audience` text NOT NULL,
	`review` text,
	`resolved` text DEFAULT '{}' NOT NULL,
	`model` text,
	`cost_usd` real DEFAULT 0 NOT NULL,
	`error` text,
	`created_at` integer NOT NULL,
	`finished_at` integer,
	FOREIGN KEY (`broadcast_id`) REFERENCES `broadcasts`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`sequence_step_id`) REFERENCES `sequence_steps`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `council_reviews_broadcast_idx` ON `council_reviews` (`broadcast_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `council_reviews_step_idx` ON `council_reviews` (`sequence_step_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `custom_fields` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`key` text NOT NULL,
	`label` text NOT NULL,
	`type` text DEFAULT 'text' NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `custom_fields_key_key` ON `custom_fields` (`key`);--> statement-breakpoint
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
CREATE TABLE `import_runs` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`source` text NOT NULL,
	`status` text DEFAULT 'queued' NOT NULL,
	`settings` text DEFAULT '{}' NOT NULL,
	`credentials` text,
	`phase` text,
	`cursor` text,
	`phases_done` integer DEFAULT 0 NOT NULL,
	`phases_total` integer DEFAULT 0 NOT NULL,
	`pages` integer DEFAULT 0 NOT NULL,
	`created` integer DEFAULT 0 NOT NULL,
	`updated` integer DEFAULT 0 NOT NULL,
	`skipped` integer DEFAULT 0 NOT NULL,
	`invalid` integer DEFAULT 0 NOT NULL,
	`detail` text DEFAULT '{}' NOT NULL,
	`notes` text DEFAULT '[]' NOT NULL,
	`last_error` text,
	`failures` integer DEFAULT 0 NOT NULL,
	`locked_until` integer,
	`created_at` integer NOT NULL,
	`started_at` integer,
	`finished_at` integer,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `import_runs_status_idx` ON `import_runs` (`status`,`created_at`);--> statement-breakpoint
CREATE TABLE `launches` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`slug` text NOT NULL,
	`name` text NOT NULL,
	`step` text DEFAULT 'offer' NOT NULL,
	`status` text DEFAULT 'draft' NOT NULL,
	`offer` text,
	`audience` text,
	`problem` text,
	`promise` text,
	`story` text,
	`objections` text,
	`price_note` text,
	`store_offer_id` integer,
	`template_slug` text,
	`starts_on` integer,
	`campaign_id` integer,
	`sequence_id` integer,
	`trigger_tag_id` integer,
	`outline` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`handed_off_at` integer,
	`closed_at` integer,
	FOREIGN KEY (`store_offer_id`) REFERENCES `store_offers`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`campaign_id`) REFERENCES `campaigns`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`sequence_id`) REFERENCES `sequences`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`trigger_tag_id`) REFERENCES `tags`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `launches_slug_key` ON `launches` (`slug`);--> statement-breakpoint
CREATE INDEX `launches_status_idx` ON `launches` (`status`);--> statement-breakpoint
CREATE TABLE `list_prunes` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`groups` text NOT NULL,
	`inactive_days` integer NOT NULL,
	`subscriber_ids` text NOT NULL,
	`planned` text NOT NULL,
	`total` integer NOT NULL,
	`position` integer DEFAULT 0 NOT NULL,
	`deleted` integer DEFAULT 0 NOT NULL,
	`deleted_by_group` text DEFAULT '{}' NOT NULL,
	`skipped` integer DEFAULT 0 NOT NULL,
	`status` text DEFAULT 'planned' NOT NULL,
	`backed_up_at` integer,
	`created_at` integer NOT NULL,
	`confirmed_at` integer,
	`finished_at` integer
);
--> statement-breakpoint
CREATE INDEX `list_prunes_created_idx` ON `list_prunes` (`created_at`);--> statement-breakpoint
CREATE TABLE `member_sessions` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`subscriber_id` integer NOT NULL,
	`token_hash` text NOT NULL,
	`sign_in_link_id` integer,
	`ip` text,
	`user_agent` text,
	`created_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	`last_seen_at` integer NOT NULL,
	`revoked_at` integer,
	FOREIGN KEY (`subscriber_id`) REFERENCES `subscribers`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`sign_in_link_id`) REFERENCES `member_sign_in_links`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `member_sessions_token_key` ON `member_sessions` (`token_hash`);--> statement-breakpoint
CREATE INDEX `member_sessions_subscriber_idx` ON `member_sessions` (`subscriber_id`);--> statement-breakpoint
CREATE TABLE `member_sign_in_links` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`subscriber_id` integer NOT NULL,
	`status` text DEFAULT 'requested' NOT NULL,
	`token_hash` text,
	`expires_at` integer,
	`message_id` integer,
	`return_post_id` integer,
	`blocked_reason` text,
	`requested_ip` text,
	`requested_user_agent` text,
	`created_at` integer NOT NULL,
	`used_at` integer,
	FOREIGN KEY (`subscriber_id`) REFERENCES `subscribers`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`message_id`) REFERENCES `messages`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`return_post_id`) REFERENCES `broadcasts`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `member_sign_in_links_token_key` ON `member_sign_in_links` (`token_hash`);--> statement-breakpoint
CREATE INDEX `member_sign_in_links_subscriber_idx` ON `member_sign_in_links` (`subscriber_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `member_sign_in_links_ip_idx` ON `member_sign_in_links` (`requested_ip`,`created_at`);--> statement-breakpoint
CREATE TABLE `member_subscriptions` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`subscriber_id` integer NOT NULL,
	`checkout_id` integer,
	`status` text NOT NULL,
	`interval` text NOT NULL,
	`amount_cents` integer NOT NULL,
	`currency` text NOT NULL,
	`stripe_customer_id` text,
	`stripe_subscription_id` text NOT NULL,
	`stripe_price_id` text NOT NULL,
	`converted_from_post_id` integer,
	`current_period_end_at` integer,
	`cancel_at_period_end` integer DEFAULT false NOT NULL,
	`cancel_reason` text,
	`status_changed_at` integer NOT NULL,
	`past_due_at` integer,
	`canceled_at` integer,
	`stripe_event_at` integer,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`subscriber_id`) REFERENCES `subscribers`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`checkout_id`) REFERENCES `premium_checkouts`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`converted_from_post_id`) REFERENCES `broadcasts`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `member_subscriptions_stripe_key` ON `member_subscriptions` (`stripe_subscription_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `member_subscriptions_live_key` ON `member_subscriptions` (`subscriber_id`) WHERE status <> 'canceled';--> statement-breakpoint
CREATE INDEX `member_subscriptions_status_idx` ON `member_subscriptions` (`status`);--> statement-breakpoint
CREATE TABLE `oauth_clients` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`client_id` text NOT NULL,
	`client_name` text NOT NULL,
	`redirect_uris` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `oauth_clients_client_id_key` ON `oauth_clients` (`client_id`);--> statement-breakpoint
CREATE TABLE `oauth_codes` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`code_hash` text NOT NULL,
	`client_id` integer NOT NULL,
	`redirect_uri` text NOT NULL,
	`code_challenge` text NOT NULL,
	`access` text NOT NULL,
	`approved_by` text,
	`expires_at` integer NOT NULL,
	`used_at` integer,
	`grant_id` integer,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`client_id`) REFERENCES `oauth_clients`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`grant_id`) REFERENCES `oauth_grants`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `oauth_codes_hash_key` ON `oauth_codes` (`code_hash`);--> statement-breakpoint
CREATE TABLE `oauth_grants` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`client_id` integer NOT NULL,
	`access` text DEFAULT 'read' NOT NULL,
	`redirect_uri` text NOT NULL,
	`approved_by` text,
	`created_at` integer NOT NULL,
	`last_used_at` integer,
	`revoked_at` integer,
	FOREIGN KEY (`client_id`) REFERENCES `oauth_clients`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `oauth_grants_client_idx` ON `oauth_grants` (`client_id`);--> statement-breakpoint
CREATE TABLE `oauth_tokens` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`grant_id` integer NOT NULL,
	`kind` text NOT NULL,
	`token_hash` text NOT NULL,
	`expires_at` integer NOT NULL,
	`used_at` integer,
	`revoked_at` integer,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`grant_id`) REFERENCES `oauth_grants`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `oauth_tokens_hash_key` ON `oauth_tokens` (`token_hash`);--> statement-breakpoint
CREATE INDEX `oauth_tokens_grant_idx` ON `oauth_tokens` (`grant_id`);--> statement-breakpoint
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
--> statement-breakpoint
CREATE TABLE `premium_checkouts` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`token` text NOT NULL,
	`interval` text NOT NULL,
	`stripe_price_id` text NOT NULL,
	`subscriber_id` integer,
	`converted_from_post_id` integer,
	`stripe_session_id` text,
	`status` text DEFAULT 'open' NOT NULL,
	`note` text,
	`stripe_subscription_id` text,
	`stripe_customer_id` text,
	`ip` text,
	`user_agent` text,
	`created_at` integer NOT NULL,
	`completed_at` integer,
	FOREIGN KEY (`subscriber_id`) REFERENCES `subscribers`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`converted_from_post_id`) REFERENCES `broadcasts`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `premium_checkouts_token_key` ON `premium_checkouts` (`token`);--> statement-breakpoint
CREATE UNIQUE INDEX `premium_checkouts_session_key` ON `premium_checkouts` (`stripe_session_id`);--> statement-breakpoint
CREATE INDEX `premium_checkouts_ip_idx` ON `premium_checkouts` (`ip`,`created_at`);--> statement-breakpoint
CREATE INDEX `premium_checkouts_status_idx` ON `premium_checkouts` (`status`);--> statement-breakpoint
CREATE TABLE `premium_settings` (
	`id` integer PRIMARY KEY NOT NULL,
	`monthly_price_id` text,
	`yearly_price_id` text,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
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
CREATE INDEX `sending_domains_next_check_idx` ON `sending_domains` (`next_check_at`);--> statement-breakpoint
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
CREATE INDEX `sequence_takes_status_idx` ON `sequence_takes` (`status`,`created_at`);--> statement-breakpoint
CREATE TABLE `store_checkouts` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`token` text NOT NULL,
	`stripe_price_id` text NOT NULL,
	`stripe_product_id` text NOT NULL,
	`offer_slug` text NOT NULL,
	`amount_cents` integer NOT NULL,
	`currency` text NOT NULL,
	`converted_from_broadcast_id` integer,
	`subscriber_id` integer,
	`sale_id` integer,
	`status` text DEFAULT 'started' NOT NULL,
	`stripe_session_id` text,
	`last_error` text,
	`ip` text,
	`user_agent` text,
	`created_at` integer NOT NULL,
	`completed_at` integer,
	FOREIGN KEY (`converted_from_broadcast_id`) REFERENCES `broadcasts`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`subscriber_id`) REFERENCES `subscribers`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`sale_id`) REFERENCES `sales`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `store_checkouts_token_key` ON `store_checkouts` (`token`);--> statement-breakpoint
CREATE INDEX `store_checkouts_ip_idx` ON `store_checkouts` (`ip`,`created_at`);--> statement-breakpoint
CREATE INDEX `store_checkouts_broadcast_idx` ON `store_checkouts` (`converted_from_broadcast_id`);--> statement-breakpoint
CREATE INDEX `store_checkouts_sale_idx` ON `store_checkouts` (`sale_id`);--> statement-breakpoint
CREATE TABLE `store_offers` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`product_id` text NOT NULL,
	`price_id` text NOT NULL,
	`slug` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`product_id`) REFERENCES `stripe_products`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`price_id`) REFERENCES `stripe_prices`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `store_offers_product_key` ON `store_offers` (`product_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `store_offers_slug_key` ON `store_offers` (`slug`);--> statement-breakpoint
CREATE TABLE `team_members` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`email` text NOT NULL,
	`role` text NOT NULL,
	`invited_at` integer NOT NULL,
	`joined_at` integer,
	`removed_at` integer,
	`invited_by` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `team_members_email_idx` ON `team_members` (`email`);--> statement-breakpoint
CREATE TABLE `testimonials` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`subscriber_id` integer NOT NULL,
	`display_name` text NOT NULL,
	`body` text NOT NULL,
	`may_publish` integer DEFAULT false NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`created_at` integer NOT NULL,
	`decided_at` integer,
	FOREIGN KEY (`subscriber_id`) REFERENCES `subscribers`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `testimonials_status_idx` ON `testimonials` (`status`,`created_at`);--> statement-breakpoint
CREATE INDEX `testimonials_subscriber_idx` ON `testimonials` (`subscriber_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `transactional_templates` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`slug` text NOT NULL,
	`name` text NOT NULL,
	`subject` text NOT NULL,
	`body_json` text,
	`body_md` text,
	`is_active` integer DEFAULT true NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `transactional_templates_slug_key` ON `transactional_templates` (`slug`);--> statement-breakpoint
CREATE TABLE `webhook_deliveries` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`endpoint_id` integer NOT NULL,
	`event` text NOT NULL,
	`event_id` text NOT NULL,
	`payload` text NOT NULL,
	`occurred_at` integer NOT NULL,
	`dedupe_key` text,
	`status` text DEFAULT 'pending' NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`next_attempt_at` integer,
	`last_attempt_at` integer,
	`last_status_code` integer,
	`last_error` text,
	`last_response` text,
	`delivered_at` integer,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`endpoint_id`) REFERENCES `webhook_endpoints`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `webhook_deliveries_due_idx` ON `webhook_deliveries` (`status`,`next_attempt_at`);--> statement-breakpoint
CREATE INDEX `webhook_deliveries_endpoint_idx` ON `webhook_deliveries` (`endpoint_id`,`created_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `webhook_deliveries_dedupe_key` ON `webhook_deliveries` (`endpoint_id`,`dedupe_key`) WHERE dedupe_key is not null;--> statement-breakpoint
CREATE TABLE `webhook_endpoints` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`url` text NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	`events` text NOT NULL,
	`secret` text NOT NULL,
	`secret_prefix` text NOT NULL,
	`is_active` integer DEFAULT true NOT NULL,
	`disabled_reason` text,
	`disabled_at` integer,
	`consecutive_failures` integer DEFAULT 0 NOT NULL,
	`last_delivered_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
ALTER TABLE `ai_calls` ADD `provider` text DEFAULT 'openrouter' NOT NULL;--> statement-breakpoint
ALTER TABLE `ai_calls` ADD `cost_estimated` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `broadcasts` ADD `audience_upper_id` integer;--> statement-breakpoint
ALTER TABLE `broadcasts` ADD `imported_source_id` text;--> statement-breakpoint
ALTER TABLE `broadcasts` ADD `access_level` text DEFAULT 'public' NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX `broadcasts_imported_source_key` ON `broadcasts` (`imported_from`,`imported_source_id`);--> statement-breakpoint
ALTER TABLE `events` ADD `machine` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `forms` ADD `double_opt_in` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `mcp_calls` ADD `oauth_grant_id` integer REFERENCES oauth_grants(id);--> statement-breakpoint
ALTER TABLE `messages` ADD `template_slug` text;--> statement-breakpoint
ALTER TABLE `messages` ADD `claimed_at` integer;--> statement-breakpoint
CREATE INDEX `messages_template_slug_idx` ON `messages` (`template_slug`) WHERE template_slug is not null;--> statement-breakpoint
CREATE INDEX `messages_created_idx` ON `messages` (`created_at`);--> statement-breakpoint
ALTER TABLE `sequences` ADD `send_window_start` integer;--> statement-breakpoint
ALTER TABLE `sequences` ADD `send_window_end` integer;--> statement-breakpoint
ALTER TABLE `sequences` ADD `imported_source_id` text;--> statement-breakpoint
CREATE UNIQUE INDEX `sequences_imported_source_key` ON `sequences` (`imported_from`,`imported_source_id`);--> statement-breakpoint
ALTER TABLE `site_settings` ADD `time_zone` text;