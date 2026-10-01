CREATE TABLE `counterparty_ignores` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`user_id` integer NOT NULL,
	`kind` text NOT NULL,
	`normalized` text NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `counterparty_ignores_user_kind_normalized_uq` ON `counterparty_ignores` (`user_id`,`kind`,`normalized`);--> statement-breakpoint
CREATE TABLE `participant_identities` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`user_id` integer NOT NULL,
	`participant_id` integer NOT NULL,
	`kind` text NOT NULL,
	`value` text NOT NULL,
	`normalized` text NOT NULL,
	`source` text DEFAULT 'manual' NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`participant_id`) REFERENCES `participants`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `participant_identities_participant_idx` ON `participant_identities` (`participant_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `participant_identities_user_kind_normalized_uq` ON `participant_identities` (`user_id`,`kind`,`normalized`);--> statement-breakpoint
-- Data copy: participants.aliases (JSON array) → participant_identities. Kind is a guess: any
-- non-ASCII character (CJK, emoji, full-width) or a wxid_ id means a WeChat nickname, anything
-- else a Zelle display name. normalized = lower(trim) with runs of spaces collapsed, as in core
-- normalizeIdentity. A value two participants share goes to the first one (OR IGNORE).
INSERT OR IGNORE INTO `participant_identities` (`user_id`, `participant_id`, `kind`, `value`, `normalized`, `source`, `created_at`)
SELECT a.user_id, a.participant_id,
  CASE WHEN a.v GLOB '*[^ -~]*' OR lower(a.v) LIKE 'wxid\_%' ESCAPE '\' THEN 'wechat' ELSE 'zelle_name' END,
  a.v,
  lower(replace(replace(replace(replace(a.v, '  ', ' '), '  ', ' '), '  ', ' '), '  ', ' ')),
  'manual',
  strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
FROM (
  SELECT p.user_id AS user_id, p.id AS participant_id, trim(j.value) AS v
  FROM `participants` p, json_each(CASE WHEN json_valid(p.aliases) THEN p.aliases ELSE '[]' END) j
  WHERE j.type = 'text' AND trim(j.value) <> ''
  ORDER BY p.id, j.key
) a;