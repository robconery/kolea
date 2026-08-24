ALTER TABLE `broadcasts` ADD `imported_recipients` integer;--> statement-breakpoint
ALTER TABLE `broadcasts` ADD `imported_opened` integer;--> statement-breakpoint
ALTER TABLE `broadcasts` ADD `imported_clicked` integer;--> statement-breakpoint
ALTER TABLE `broadcasts` ADD `imported_unsubscribed` integer;--> statement-breakpoint
ALTER TABLE `broadcasts` ADD `imported_from` text;