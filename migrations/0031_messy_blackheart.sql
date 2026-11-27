ALTER TABLE `messages` ADD `provider_called_at` integer;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `messages_broadcast_status_idx` ON `messages` (`broadcast_id`,`status`);--> statement-breakpoint
DROP INDEX IF EXISTS `messages_broadcast_idx`;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS messages_provider_message_id_idx ON messages (provider_message_id);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `sequence_enrollments_subscriber_idx` ON `sequence_enrollments` (`subscriber_id`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `subscriber_tags_tag_idx` ON `subscriber_tags` (`tag_id`,`subscriber_id`);
