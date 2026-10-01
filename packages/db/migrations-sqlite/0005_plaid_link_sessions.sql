CREATE TABLE `plaid_link_sessions` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`user_id` integer NOT NULL,
	`link_token` text NOT NULL,
	`environment` text NOT NULL,
	`purpose` text NOT NULL,
	`connection_id` integer,
	`status` text DEFAULT 'open' NOT NULL,
	`link_session_id` text,
	`exchanged` text,
	`created_at` text NOT NULL,
	`checked_at` text,
	`last_error` text,
	FOREIGN KEY (`connection_id`) REFERENCES `bank_connections`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `plaid_link_sessions_user_status_idx` ON `plaid_link_sessions` (`user_id`,`status`);--> statement-breakpoint
CREATE UNIQUE INDEX `plaid_link_sessions_link_token_uq` ON `plaid_link_sessions` (`link_token`);