CREATE TABLE `bank_accounts` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`user_id` integer NOT NULL,
	`connection_id` integer NOT NULL,
	`provider_account_id` text NOT NULL,
	`account_id` integer NOT NULL,
	`name` text NOT NULL,
	`type` text NOT NULL,
	`subtype` text,
	`last_four` text,
	`currency` text NOT NULL,
	`cursor` text,
	`created_at` text NOT NULL,
	FOREIGN KEY (`connection_id`) REFERENCES `bank_connections`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `bank_accounts_connection_provider_account_uq` ON `bank_accounts` (`connection_id`,`provider_account_id`);--> statement-breakpoint
CREATE TABLE `bank_connections` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`user_id` integer NOT NULL,
	`provider` text NOT NULL,
	`enrollment_id` text NOT NULL,
	`institution_name` text,
	`access_token` text NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`last_error` text,
	`last_synced_at` text,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `bank_connections_user_provider_enrollment_uq` ON `bank_connections` (`user_id`,`provider`,`enrollment_id`);