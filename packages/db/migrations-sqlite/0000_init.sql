CREATE TABLE `accounts` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`user_id` integer NOT NULL,
	`name` text NOT NULL,
	`kind` text NOT NULL,
	`institution` text,
	`last4` text,
	`currency` text NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `accounts_user_kind_inst_last4_name_uq` ON `accounts` (`user_id`,`kind`,`institution`,`last4`,`name`);--> statement-breakpoint
CREATE TABLE `categories` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`user_id` integer NOT NULL,
	`name` text NOT NULL,
	`kind` text NOT NULL,
	`is_system` integer DEFAULT false NOT NULL,
	`sort` integer DEFAULT 0 NOT NULL,
	`archived_at` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `categories_user_name_uq` ON `categories` (`user_id`,`name`);--> statement-breakpoint
CREATE TABLE `import_batches` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`user_id` integer NOT NULL,
	`source` text NOT NULL,
	`file_name` text NOT NULL,
	`file_hash` text NOT NULL,
	`rows_total` integer DEFAULT 0 NOT NULL,
	`rows_inserted` integer DEFAULT 0 NOT NULL,
	`rows_skipped_dup` integer DEFAULT 0 NOT NULL,
	`rows_linked` integer DEFAULT 0 NOT NULL,
	`declared` text,
	`parsed` text,
	`status` text DEFAULT 'committed' NOT NULL,
	`created_at` text NOT NULL,
	`reverted_at` text
);
--> statement-breakpoint
CREATE TABLE `jobs` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`user_id` integer NOT NULL,
	`name` text NOT NULL,
	`cursor` text,
	`status` text DEFAULT 'idle' NOT NULL,
	`run_after` text,
	`attempts` integer DEFAULT 0 NOT NULL,
	`last_error` text,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `jobs_user_name_uq` ON `jobs` (`user_id`,`name`);--> statement-breakpoint
CREATE TABLE `merchant_rules` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`user_id` integer NOT NULL,
	`merchant` text NOT NULL,
	`category_id` integer,
	`participant_ids` text,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`category_id`) REFERENCES `categories`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `merchant_rules_user_merchant_uq` ON `merchant_rules` (`user_id`,`merchant`);--> statement-breakpoint
CREATE TABLE `monthly_targets` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`user_id` integer NOT NULL,
	`month` text,
	`amount_minor` integer NOT NULL,
	`currency` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `participants` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`user_id` integer NOT NULL,
	`name` text NOT NULL,
	`is_self` integer DEFAULT false NOT NULL,
	`aliases` text DEFAULT '[]' NOT NULL,
	`archived_at` text,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `participants_user_name_uq` ON `participants` (`user_id`,`name`);--> statement-breakpoint
CREATE TABLE `settlements` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`user_id` integer NOT NULL,
	`participant_id` integer NOT NULL,
	`amount_minor` integer NOT NULL,
	`currency` text NOT NULL,
	`original_amount_minor` integer,
	`original_currency` text,
	`settled_on` text NOT NULL,
	`note` text,
	`transaction_id` integer,
	`created_at` text NOT NULL,
	FOREIGN KEY (`participant_id`) REFERENCES `participants`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`transaction_id`) REFERENCES `transactions`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `transaction_splits` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`user_id` integer NOT NULL,
	`transaction_id` integer NOT NULL,
	`participant_id` integer NOT NULL,
	`currency` text NOT NULL,
	`owed_minor` integer NOT NULL,
	`paid_minor` integer DEFAULT 0 NOT NULL,
	`method` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`transaction_id`) REFERENCES `transactions`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`participant_id`) REFERENCES `participants`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `transaction_splits_tx_participant_uq` ON `transaction_splits` (`transaction_id`,`participant_id`);--> statement-breakpoint
CREATE TABLE `transactions` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`user_id` integer NOT NULL,
	`account_id` integer,
	`occurred_at` text NOT NULL,
	`amount_minor` integer NOT NULL,
	`currency` text NOT NULL,
	`original_amount_minor` integer,
	`original_currency` text,
	`kind` text NOT NULL,
	`counterparty_raw` text DEFAULT '' NOT NULL,
	`description_raw` text DEFAULT '' NOT NULL,
	`merchant` text DEFAULT '' NOT NULL,
	`category_id` integer,
	`note` text,
	`source` text NOT NULL,
	`source_ref` text,
	`source_category` text,
	`payment_method` text,
	`raw` text,
	`import_batch_id` integer,
	`dedup_key` text NOT NULL,
	`duplicate_of_id` integer,
	`status` text DEFAULT 'ok' NOT NULL,
	`user_edited_at` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`category_id`) REFERENCES `categories`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`import_batch_id`) REFERENCES `import_batches`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`duplicate_of_id`) REFERENCES `transactions`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `transactions_user_occurred_at_idx` ON `transactions` (`user_id`,`occurred_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `transactions_user_dedup_key_uq` ON `transactions` (`user_id`,`dedup_key`);