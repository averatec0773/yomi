CREATE TABLE `account_balance_snapshots` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`user_id` integer NOT NULL,
	`account_id` integer NOT NULL,
	`as_of` text NOT NULL,
	`balance_minor` integer NOT NULL,
	`currency` text NOT NULL,
	`source` text NOT NULL,
	`raw` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `account_balance_snapshots_user_as_of_idx` ON `account_balance_snapshots` (`user_id`,`as_of`);--> statement-breakpoint
CREATE UNIQUE INDEX `account_balance_snapshots_account_as_of_currency_uq` ON `account_balance_snapshots` (`account_id`,`as_of`,`currency`);--> statement-breakpoint
ALTER TABLE `accounts` ADD `starting_balance_minor` integer;--> statement-breakpoint
ALTER TABLE `accounts` ADD `starting_balance_on` text;