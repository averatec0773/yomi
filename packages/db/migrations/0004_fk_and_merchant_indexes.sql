-- Indexes for foreign keys into transactions (each delete checks or cascades through them; duplicate and settlement
-- probes during import, revert and sync) and for per-merchant lookups (split suggestions, rules, refund categories).
CREATE INDEX "settlement_items_transaction_idx" ON "settlement_items" USING btree ("transaction_id");--> statement-breakpoint
CREATE INDEX "settlements_transaction_idx" ON "settlements" USING btree ("transaction_id");--> statement-breakpoint
CREATE INDEX "transactions_user_merchant_idx" ON "transactions" USING btree ("user_id","merchant");--> statement-breakpoint
CREATE INDEX "transactions_duplicate_of_idx" ON "transactions" USING btree ("duplicate_of_id");