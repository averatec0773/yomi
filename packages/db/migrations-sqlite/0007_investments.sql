CREATE TABLE `holding_snapshots` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`user_id` integer NOT NULL,
	`investment_account_id` integer NOT NULL,
	`security_id` integer,
	`position_key` text NOT NULL,
	`as_of` text NOT NULL,
	`quantity` text NOT NULL,
	`price` text NOT NULL,
	`market_value_minor` integer NOT NULL,
	`cost_basis_minor` integer,
	`currency` text NOT NULL,
	`source_raw` text,
	`created_at` text NOT NULL,
	FOREIGN KEY (`investment_account_id`) REFERENCES `investment_accounts`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`security_id`) REFERENCES `securities`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `holding_snapshots_user_as_of_idx` ON `holding_snapshots` (`user_id`,`as_of`);--> statement-breakpoint
CREATE UNIQUE INDEX `holding_snapshots_account_position_as_of_uq` ON `holding_snapshots` (`investment_account_id`,`position_key`,`as_of`);--> statement-breakpoint
CREATE TABLE `investment_accounts` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`user_id` integer NOT NULL,
	`provider` text NOT NULL,
	`external_id` text NOT NULL,
	`bank_connection_id` integer,
	`name` text NOT NULL,
	`currency` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`bank_connection_id`) REFERENCES `bank_connections`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `investment_accounts_user_provider_external_uq` ON `investment_accounts` (`user_id`,`provider`,`external_id`);--> statement-breakpoint
CREATE TABLE `investment_transactions` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`user_id` integer NOT NULL,
	`investment_account_id` integer NOT NULL,
	`security_id` integer,
	`external_id` text NOT NULL,
	`date` text NOT NULL,
	`type` text NOT NULL,
	`quantity` text,
	`amount_minor` integer NOT NULL,
	`currency` text NOT NULL,
	`description` text,
	`raw` text,
	`created_at` text NOT NULL,
	FOREIGN KEY (`investment_account_id`) REFERENCES `investment_accounts`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`security_id`) REFERENCES `securities`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `investment_transactions_user_date_idx` ON `investment_transactions` (`user_id`,`date`);--> statement-breakpoint
CREATE UNIQUE INDEX `investment_transactions_account_external_uq` ON `investment_transactions` (`investment_account_id`,`external_id`);--> statement-breakpoint
CREATE TABLE `securities` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`user_id` integer NOT NULL,
	`provider` text NOT NULL,
	`external_id` text NOT NULL,
	`symbol` text,
	`name` text,
	`type` text,
	`currency` text NOT NULL,
	`isin` text,
	`cusip` text,
	`multiplier` text,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `securities_user_provider_external_uq` ON `securities` (`user_id`,`provider`,`external_id`);--> statement-breakpoint
ALTER TABLE `bank_connections` ADD `kind` text DEFAULT 'bank' NOT NULL;--> statement-breakpoint
ALTER TABLE `plaid_link_sessions` ADD `kind` text DEFAULT 'bank' NOT NULL;