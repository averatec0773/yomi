-- Income: category keys and the counts-as-income flag; own-account transfer links and the rule that made a row a
-- transfer (with its prior kind, for undo); dismissed review proposals. Text columns COLLATE "C", added by hand.
ALTER TABLE "categories" ADD COLUMN "key" text COLLATE "C";--> statement-breakpoint
ALTER TABLE "categories" ADD COLUMN "counts_as_income" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "transactions" ADD COLUMN "transfer_peer_id" integer;--> statement-breakpoint
ALTER TABLE "transactions" ADD COLUMN "kind_rule" text COLLATE "C";--> statement-breakpoint
ALTER TABLE "transactions" ADD COLUMN "prior_kind" text COLLATE "C";--> statement-breakpoint
ALTER TABLE "transactions" ADD COLUMN "review_dismissed_at" text COLLATE "C";--> statement-breakpoint
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_transfer_peer_id_transactions_id_fk" FOREIGN KEY ("transfer_peer_id") REFERENCES "public"."transactions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "categories_user_key_uq" ON "categories" USING btree ("user_id","key");--> statement-breakpoint
CREATE INDEX "transactions_transfer_peer_idx" ON "transactions" USING btree ("transfer_peer_id");