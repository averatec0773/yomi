-- Columns nothing reads or writes: participants.aliases (replaced by participant_identities) and bank_accounts.cursor
-- (Plaid keeps one cursor per Item, on bank_connections).
ALTER TABLE "bank_accounts" DROP COLUMN "cursor";--> statement-breakpoint
ALTER TABLE "participants" DROP COLUMN "aliases";
