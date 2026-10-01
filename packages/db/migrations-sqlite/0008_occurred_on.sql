CREATE TABLE `user_settings` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`user_id` integer NOT NULL,
	`key` text NOT NULL,
	`value` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `user_settings_user_key_uq` ON `user_settings` (`user_id`,`key`);--> statement-breakpoint
ALTER TABLE `transactions` ADD `occurred_on` text DEFAULT '' NOT NULL;--> statement-breakpoint
CREATE INDEX `transactions_user_occurred_on_idx` ON `transactions` (`user_id`,`occurred_on`);--> statement-breakpoint
-- Provisional day: the source's own date (what every query used before). On the next app start core
-- ensureOccurredOn recomputes all rows in the user's time zone (default America/Chicago); SQLite has
-- no time zone rules, so that step runs in code.
UPDATE `transactions` SET `occurred_on` = substr(`occurred_at`, 1, 10);--> statement-breakpoint
-- Inserts that do not set occurred_on (core always does) fall back to the source's own date.
CREATE TRIGGER `transactions_occurred_on_default` AFTER INSERT ON `transactions`
WHEN NEW.`occurred_on` = ''
BEGIN
  UPDATE `transactions` SET `occurred_on` = substr(NEW.`occurred_at`, 1, 10) WHERE `id` = NEW.`id`;
END;