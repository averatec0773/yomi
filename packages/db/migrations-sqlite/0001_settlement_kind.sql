ALTER TABLE `settlements` ADD `kind` text DEFAULT 'payment' NOT NULL;--> statement-breakpoint
ALTER TABLE `settlements` ADD `prior_kind` text;--> statement-breakpoint
UPDATE `settlements` SET `kind` = 'opening' WHERE substr(`note`, 1, 4) = '期初余额';
