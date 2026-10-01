CREATE TABLE `settlement_items` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`user_id` integer NOT NULL,
	`settlement_id` integer NOT NULL,
	`transaction_id` integer NOT NULL,
	`participant_id` integer NOT NULL,
	`amount_minor` integer NOT NULL,
	`currency` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`settlement_id`) REFERENCES `settlements`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`transaction_id`) REFERENCES `transactions`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`participant_id`) REFERENCES `participants`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `settlement_items_participant_idx` ON `settlement_items` (`participant_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `settlement_items_settlement_tx_uq` ON `settlement_items` (`settlement_id`,`transaction_id`);--> statement-breakpoint
ALTER TABLE `settlements` ADD `fx_rate` text;--> statement-breakpoint
ALTER TABLE `transactions` ADD `shared_note` text;