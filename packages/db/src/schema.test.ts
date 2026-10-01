import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeDb, createDb, type Db, listTables, migrate, queryRows } from "./index";
import { resetDb } from "./testing";

let db: Db;
beforeAll(async () => {
  db = await createDb("memory://");
  await migrate(db);
});
afterAll(async () => {
  await closeDb(db);
});

async function seed(): Promise<void> {
  await resetDb(db);
  await db.execute(sql`insert into accounts (user_id, name, kind, currency, created_at) values (1, 'A', 'wallet', 'CNY', 'x')`);
}

function insertTx(dedupKey: string, occurredOn = "2026-09-30", accountId = 1) {
  return db.execute(
    sql`insert into transactions (user_id, account_id, occurred_at, occurred_on, amount_minor, currency, kind, source, dedup_key, created_at, updated_at)
        values (1, ${accountId}, '2026-09-30T23:30:00-05:00', ${occurredOn}, -100, 'USD', 'expense', 'manual', ${dedupKey}, 'x', 'x')`,
  );
}

/** The Postgres error under drizzle's "Failed query" wrapper. */
async function pgError(p: Promise<unknown>): Promise<{ code?: string; constraint?: string }> {
  const e = await p.then(
    () => null,
    (err: unknown) => err as { cause?: { code?: string; constraint?: string } },
  );
  if (!e) throw new Error("expected the statement to fail");
  return e.cause ?? {};
}

describe("migrations", () => {
  it("create every table on an in-memory db, each with a NOT NULL user_id", async () => {
    const tables = await listTables(db);
    expect(tables).toEqual([
      "account_balance_snapshots",
      "accounts",
      "bank_accounts",
      "bank_connections",
      "categories",
      "counterparty_ignores",
      "holding_snapshots",
      "import_batches",
      "investment_accounts",
      "investment_transactions",
      "jobs",
      "merchant_rules",
      "monthly_targets",
      "participant_identities",
      "participants",
      "plaid_link_sessions",
      "securities",
      "settlement_items",
      "settlements",
      "transaction_splits",
      "transactions",
      "user_settings",
    ]);
    const cols = await queryRows<{ table_name: string; is_nullable: string }>(
      db,
      sql`select table_name, is_nullable from information_schema.columns where table_schema = 'public' and column_name = 'user_id' order by table_name`,
    );
    expect(cols.map((c) => c.table_name)).toEqual(tables);
    for (const c of cols) expect(c.is_nullable, c.table_name).toBe("NO");
  });

  it("is idempotent: a second run applies nothing and logs one migration per journal entry", async () => {
    await migrate(db);
    const log = await queryRows<{ n: number }>(db, sql`select count(*)::int as n from drizzle.__drizzle_migrations`);
    expect(log[0]!.n).toBe(1);
    expect(await listTables(db)).toHaveLength(22);
  });

  it("enforces foreign keys", async () => {
    await seed();
    expect(await pgError(insertTx("bad-fk", "2026-09-30", 999))).toMatchObject({ code: "23503", constraint: "transactions_account_id_accounts_id_fk" });
    const split = db.execute(sql`insert into transaction_splits (user_id, transaction_id, participant_id, currency, owed_minor, method, created_at, updated_at)
                                 values (1, 12345, 1, 'USD', 1, 'equal', 'x', 'x')`);
    expect((await pgError(split)).code).toBe("23503");
  });

  it("fills an empty occurred_on from occurred_at's own date and keeps a given one", async () => {
    await seed();
    await insertTx("empty-day", "");
    await insertTx("given-day", "2026-10-01");
    const rows = await queryRows<{ dedup_key: string; occurred_on: string }>(db, sql`select dedup_key, occurred_on from transactions order by id`);
    expect(rows).toEqual([
      { dedup_key: "empty-day", occurred_on: "2026-09-30" },
      { dedup_key: "given-day", occurred_on: "2026-10-01" },
    ]);
  });

  it("keeps the unique indexes: (user_id, dedup_key) on transactions", async () => {
    await seed();
    await insertTx("same");
    expect(await pgError(insertTx("same"))).toMatchObject({ code: "23505", constraint: "transactions_user_dedup_key_uq" });
    const idx = await queryRows<{ indexname: string }>(db, sql`select indexname from pg_indexes where schemaname = 'public' and indexdef like 'CREATE UNIQUE INDEX%' order by indexname`);
    expect(idx.map((i) => i.indexname)).toEqual(
      expect.arrayContaining(["transactions_user_dedup_key_uq", "user_settings_user_key_uq", "transaction_splits_tx_participant_uq", "participants_user_name_uq"]),
    );
  });

  it("defaults settlements.kind to payment and stores booleans and jsonb natively", async () => {
    await resetDb(db);
    await db.execute(sql`insert into participants (user_id, name, created_at) values (1, 'A', 'x')`);
    await db.execute(sql`insert into settlements (user_id, participant_id, amount_minor, currency, settled_on, created_at) values (1, 1, 50, 'CNY', '2026-09-02', 'x')`);
    await db.execute(sql`insert into merchant_rules (user_id, merchant, participant_ids, updated_at) values (1, 'M', '[1]'::jsonb, 'x')`);
    const s = await queryRows<{ kind: string; prior_kind: string | null }>(db, sql`select kind, prior_kind from settlements`);
    expect(s).toEqual([{ kind: "payment", prior_kind: null }]);
    const p = await queryRows<{ is_self: unknown; aliases: string }>(db, sql`select is_self, aliases from participants`);
    expect(p).toEqual([{ is_self: false, aliases: "[]" }]);
    const m = await queryRows<{ participant_ids: unknown; auto_split: unknown; suggest: unknown }>(db, sql`select participant_ids, auto_split, suggest from merchant_rules`);
    expect(m).toEqual([{ participant_ids: [1], auto_split: false, suggest: true }]);
  });
});
