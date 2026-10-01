ALTER TABLE `merchant_rules` ADD `suggest` integer DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE `transactions` ADD `split_suggestion_dismissed_at` text;