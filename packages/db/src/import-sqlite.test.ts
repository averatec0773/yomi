import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate as migrateSqlite } from "drizzle-orm/better-sqlite3/migrator";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { closeDb, createDb, type Db, listTables, queryRows } from "./client";
import { formatImportReport, importSqliteLedger, ImportRefusedError, sqliteMigrationsFolder, verifySqliteImport } from "./import-sqlite";
import { transactions } from "./schema";

const SECRET = "enc:v1:QUJDREVGR0hJSktMTU5PUA==:c2VjcmV0LWNpcGhlcnRleHQ=";
const TOKEN = "enc:v1:MTIzNDU2Nzg5MDEy:YWNjZXNzLXNhbmRib3gtdG9rZW4=";

let dir: string;
const open: Db[] = [];

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "yomi-import-"));
});
afterEach(async () => {
  for (const db of open.splice(0)) await closeDb(db);
  rmSync(dir, { recursive: true, force: true });
});

async function target(): Promise<Db> {
  const db = await createDb("memory://");
  open.push(db);
  return db;
}

/** A copy of the archived SQLite migrations without the last one. */
function migrationsBehind(): string {
  const folder = path.join(dir, "migrations-behind");
  cpSync(sqliteMigrationsFolder(), folder, { recursive: true });
  const journal = path.join(folder, "meta", "_journal.json");
  const j = JSON.parse(readFileSync(journal, "utf8")) as { entries: unknown[] };
  j.entries = j.entries.slice(0, -1);
  writeFileSync(journal, JSON.stringify(j));
  return folder;
}

function insert(db: Database.Database, table: string, row: Record<string, unknown>): void {
  const cols = Object.keys(row);
  db.prepare(`insert into ${table} (${cols.join(", ")}) values (${cols.map(() => "?").join(", ")})`).run(...Object.values(row));
}

/** A migrated SQLite ledger with rows in every table. */
function buildLedger(opts: { folder?: string; rawOverride?: string } = {}): string {
  const file = path.join(dir, "yomi.db");
  const sqlite = new Database(file);
  sqlite.pragma("foreign_keys = ON");
  migrateSqlite(drizzle({ client: sqlite }), { migrationsFolder: opts.folder ?? sqliteMigrationsFolder() });
  if (opts.folder) {
    sqlite.close();
    return file;
  }
  const at = "2026-08-01T10:00:00.000Z";
  insert(sqlite, "accounts", { id: 1, user_id: 1, name: "Alipay", kind: "wallet", currency: "CNY", created_at: at });
  insert(sqlite, "accounts", { id: 2, user_id: 1, name: "Card", kind: "credit_card", institution: "Chase", last4: "1234", currency: "USD", starting_balance_minor: -12345, starting_balance_on: "2026-07-31", created_at: at });
  insert(sqlite, "categories", { id: 1, user_id: 1, name: "Food", kind: "expense", is_system: 1, sort: 1 });
  insert(sqlite, "categories", { id: 2, user_id: 1, name: "Salary", kind: "income", is_system: 0, sort: 2 });
  insert(sqlite, "import_batches", { id: 1, user_id: 1, source: "alipay", file_name: "a.csv", file_hash: "h", rows_total: 4, rows_inserted: 4, declared: '{"count":4,"totalMinor":-5000}', parsed: '{"count":4,"totalMinor":-5000}', created_at: at });
  // Row 2 is a duplicate of row 4, a later id: the self reference must be set after row 4 exists.
  const txs = [
    { id: 1, occurred_at: "2026-08-01T10:00:00+08:00", occurred_on: "2026-08-01", amount_minor: -3500, currency: "CNY", merchant: "星巴克", account_id: 1, category_id: 1, raw: opts.rawOverride ?? '{"交易时间":"2026-08-01 10:00:00","收/支":"支出"}' },
    { id: 2, occurred_at: "2026-08-15T10:00:00+08:00", occurred_on: "2026-08-15", amount_minor: -1500, currency: "CNY", merchant: "麦当劳", account_id: 1, category_id: 1, raw: null, duplicate_of_id: 4 },
    { id: 3, occurred_at: "2026-09-02T09:00:00-05:00", occurred_on: "2026-09-02", amount_minor: 250000, currency: "USD", merchant: "ACME", account_id: 2, category_id: 2, raw: "[1,2]" },
    { id: 4, occurred_at: "2026-08-15T10:00:00+08:00", occurred_on: "2026-08-15", amount_minor: -1500, currency: "CNY", merchant: "麦当劳", account_id: 1, category_id: 1, raw: null },
  ];
  for (const t of txs) {
    const { duplicate_of_id: _dup, ...rest } = t as typeof t & { duplicate_of_id?: number };
    insert(sqlite, "transactions", { ...rest, user_id: 1, kind: t.amount_minor < 0 ? "expense" : "income", source: "alipay", dedup_key: `k${t.id}`, import_batch_id: 1, created_at: at, updated_at: "2026-08-02T00:00:00.000Z" });
  }
  sqlite.prepare("update transactions set duplicate_of_id = 4, status = 'closed' where id = 2").run();
  insert(sqlite, "participants", { id: 1, user_id: 1, name: "Me", is_self: 1, created_at: at });
  insert(sqlite, "participants", { id: 2, user_id: 1, name: "室友", is_self: 0, aliases: '["roomie"]', created_at: at });
  insert(sqlite, "transaction_splits", { id: 1, user_id: 1, transaction_id: 1, participant_id: 1, currency: "CNY", owed_minor: 1750, paid_minor: 3500, method: "equal", created_at: at, updated_at: at });
  insert(sqlite, "transaction_splits", { id: 2, user_id: 1, transaction_id: 1, participant_id: 2, currency: "CNY", owed_minor: 1750, paid_minor: 0, method: "equal", created_at: at, updated_at: at });
  insert(sqlite, "settlements", { id: 1, user_id: 1, participant_id: 2, amount_minor: -100, currency: "CNY", settled_on: "2026-08-20", note: "期初余额", kind: "opening", created_at: at });
  insert(sqlite, "settlements", { id: 2, user_id: 1, participant_id: 2, amount_minor: 1750, currency: "USD", original_amount_minor: 12600, original_currency: "CNY", fx_rate: "7.2", settled_on: "2026-09-03", transaction_id: 3, prior_kind: "income", created_at: at });
  insert(sqlite, "settlement_items", { id: 1, user_id: 1, settlement_id: 2, transaction_id: 1, participant_id: 2, amount_minor: 1750, currency: "CNY", created_at: at });
  insert(sqlite, "merchant_rules", { id: 1, user_id: 1, merchant: "星巴克", category_id: 1, participant_ids: "[2]", auto_split: 1, suggest: 0, updated_at: at });
  insert(sqlite, "merchant_rules", { id: 2, user_id: 1, merchant: "ACME", category_id: null, participant_ids: null, auto_split: 0, suggest: 1, updated_at: at });
  insert(sqlite, "user_settings", { id: 1, user_id: 1, key: "timeZone", value: "Asia/Shanghai", updated_at: at });
  insert(sqlite, "user_settings", { id: 2, user_id: 0, key: "plaid.secret", value: SECRET, updated_at: at });
  insert(sqlite, "monthly_targets", { id: 1, user_id: 1, month: null, amount_minor: 500000, currency: "CNY" });
  insert(sqlite, "jobs", { id: 1, user_id: 1, name: "plaid-sync", status: "idle", attempts: 0, updated_at: at });
  insert(sqlite, "bank_connections", { id: 1, user_id: 1, provider: "plaid", kind: "bank", enrollment_id: "item-1", access_token: TOKEN, created_at: at });
  insert(sqlite, "plaid_link_sessions", { id: 1, user_id: 1, link_token: "link-1", environment: "sandbox", purpose: "new", connection_id: 1, status: "completed", exchanged: '["abc"]', created_at: at });
  insert(sqlite, "bank_accounts", { id: 1, user_id: 1, connection_id: 1, provider_account_id: "pa-1", account_id: 2, name: "Card", type: "credit", currency: "USD", created_at: at });
  insert(sqlite, "participant_identities", { id: 1, user_id: 1, participant_id: 2, kind: "wechat", value: "Roomie", normalized: "roomie", created_at: at });
  insert(sqlite, "counterparty_ignores", { id: 1, user_id: 1, kind: "alipay", normalized: "someone", created_at: at });
  insert(sqlite, "investment_accounts", { id: 1, user_id: 1, provider: "ibkr", external_id: "U1", name: "IBKR", currency: "USD", created_at: at });
  insert(sqlite, "securities", { id: 1, user_id: 1, provider: "ibkr", external_id: "265598", symbol: "AAPL", currency: "USD", updated_at: at });
  insert(sqlite, "holding_snapshots", { id: 1, user_id: 1, investment_account_id: 1, security_id: 1, position_key: "sec:1", as_of: "2026-09-01", quantity: "10", price: "230.5", market_value_minor: 230500, currency: "USD", created_at: at });
  insert(sqlite, "holding_snapshots", { id: 2, user_id: 1, investment_account_id: 1, security_id: null, position_key: "cash:HKD", as_of: "2026-09-01", quantity: "1000", price: "1", market_value_minor: 100000, currency: "HKD", created_at: at });
  insert(sqlite, "investment_transactions", { id: 1, user_id: 1, investment_account_id: 1, security_id: 1, external_id: "e1", date: "2026-09-01", type: "buy", quantity: "10", amount_minor: -230500, currency: "USD", created_at: at });
  insert(sqlite, "account_balance_snapshots", { id: 1, user_id: 1, account_id: 2, as_of: "2026-09-01", balance_minor: -99999, currency: "USD", source: "plaid", raw: '{"available":1.5}', created_at: at, updated_at: at });
  sqlite.close();
  return file;
}

// PGlite data directories on disk: initdb and file I/O take seconds when the whole suite runs in parallel.
describe("importSqliteLedger", { timeout: 30_000 }, () => {
  it("copies every table with ids, types, secrets and sequences intact, then verifies", async () => {
    const source = buildLedger();
    const db = await target();
    const report = await importSqliteLedger({ sourcePath: source, target: db });

    expect(report.ok, formatImportReport(report)).toBe(true);
    expect(report.tables).toHaveLength(22);
    expect(report.tables.indexOf("transactions")).toBeGreaterThan(report.tables.indexOf("accounts"));
    expect(report.tables.indexOf("transaction_splits")).toBeGreaterThan(report.tables.indexOf("transactions"));
    expect(report.rowsCopied).toBe(33);
    expect(report.settingKeys).toEqual(["plaid.secret", "timeZone"]);

    const counts = report.checks.filter((c) => c.section === "rows");
    expect(counts).toHaveLength(22);
    expect(counts.every((c) => Number(c.target) > 0)).toBe(true);

    const cats = await queryRows<{ id: number; is_system: unknown }>(db, sql`select id, is_system from categories order by id`);
    expect(cats).toEqual([
      { id: 1, is_system: true },
      { id: 2, is_system: false },
    ]);
    const rules = await queryRows<{ participant_ids: unknown; auto_split: unknown; suggest: unknown }>(
      db,
      sql`select participant_ids, auto_split, suggest from merchant_rules order by id`,
    );
    expect(rules).toEqual([
      { participant_ids: [2], auto_split: true, suggest: false },
      { participant_ids: null, auto_split: false, suggest: true },
    ]);
    const self = await queryRows<{ is_self: unknown }>(db, sql`select is_self from participants order by id`);
    expect(self.map((r) => r.is_self)).toEqual([true, false]);

    const txs = await queryRows<{ id: number; raw: unknown; merchant: string; duplicate_of_id: number | null; amount_minor: unknown; updated_at: string; created_at: string }>(
      db,
      sql`select id, raw, merchant, duplicate_of_id, amount_minor, created_at, updated_at from transactions order by id`,
    );
    expect(txs[0]!.raw).toEqual({ 交易时间: "2026-08-01 10:00:00", "收/支": "支出" });
    expect(txs[0]!.merchant).toBe("星巴克");
    expect(txs[2]!.raw).toEqual([1, 2]);
    expect(txs[1]!.duplicate_of_id).toBe(4);
    expect(txs.every((t) => t.updated_at === "2026-08-02T00:00:00.000Z" && t.created_at === "2026-08-01T10:00:00.000Z")).toBe(true);
    const sessions = await queryRows<{ exchanged: unknown }>(db, sql`select exchanged from plaid_link_sessions`);
    expect(sessions[0]!.exchanged).toEqual(["abc"]);
    const batches = await queryRows<{ declared: unknown; parsed: unknown }>(db, sql`select declared, parsed from import_batches`);
    expect(batches).toEqual([{ declared: { count: 4, totalMinor: -5000 }, parsed: { count: 4, totalMinor: -5000 } }]);
    const snaps = await queryRows<{ raw: unknown }>(db, sql`select raw from account_balance_snapshots`);
    expect(snaps[0]!.raw).toEqual({ available: 1.5 });

    const secrets = await queryRows<{ value: string }>(db, sql`select value from user_settings where user_id = 0`);
    expect(secrets[0]!.value).toBe(SECRET);
    const tokens = await queryRows<{ access_token: string }>(db, sql`select access_token from bank_connections`);
    expect(tokens[0]!.access_token).toBe(TOKEN);
    expect(report.checks.filter((c) => c.section.startsWith("secrets")).every((c) => c.target.endsWith("identical"))).toBe(true);

    // Identity sequences continue after the copied ids.
    const [fresh] = await db
      .insert(transactions)
      .values({ userId: 1, occurredAt: "2026-09-30T00:00:00Z", amountMinor: 1, currency: "USD", kind: "income", source: "manual", dedupKey: "fresh" })
      .returning({ id: transactions.id });
    expect(fresh!.id).toBe(5);

    // The printed report holds aggregates only.
    const text = formatImportReport(report);
    expect(text).toMatch(/OK: 22 tables, 33 rows copied/);
    expect(text).toContain("2026-08 CNY");
    for (const secretish of [SECRET, TOKEN, "星巴克", "室友", "Asia/Shanghai"]) expect(text).not.toContain(secretish);

    // A second import into the now non-empty target is refused.
    await expect(importSqliteLedger({ sourcePath: source, target: db })).rejects.toThrow(/not empty/);
  });

  it("verification reports a mismatch when the target differs from the source", async () => {
    const source = buildLedger();
    const db = await target();
    expect((await importSqliteLedger({ sourcePath: source, target: db })).ok).toBe(true);

    await db.execute(sql`update transactions set amount_minor = amount_minor + 1 where id = 1`);
    await db.execute(sql`update user_settings set value = value || 'x' where user_id = 0`);
    await db.execute(sql`delete from counterparty_ignores`);

    const report = await verifySqliteImport({ sourcePath: source, target: db });
    expect(report.ok).toBe(false);
    const bad = report.checks.filter((c) => !c.ok).map((c) => `${c.section}|${c.key}`);
    expect(bad).toEqual([
      "rows|counterparty_ignores",
      "transactions (month currency: count / amount sum)|2026-08 CNY",
      "secrets (sha256 of id + value)|user_settings.value",
    ]);
    expect(formatImportReport(report)).toMatch(/FAILED: 3 of \d+ checks do not match/);
    expect(formatImportReport(report)).toContain("DIFFERENT");
  });

  it("refuses a source whose schema is behind the archived migrations, writing nothing", async () => {
    const source = buildLedger({ folder: migrationsBehind() });
    const db = await target();
    await expect(importSqliteLedger({ sourcePath: source, target: db })).rejects.toThrow(ImportRefusedError);
    await expect(importSqliteLedger({ sourcePath: source, target: db })).rejects.toThrow(/Open it once with yomi v0\.1\.x/);
    expect(await listTables(db)).toEqual([]);
  });

  it("refuses a file that is not a yomi ledger", async () => {
    const file = path.join(dir, "other.db");
    const other = new Database(file);
    other.exec("create table notes (id integer primary key, body text)");
    other.close();
    const db = await target();
    await expect(importSqliteLedger({ sourcePath: file, target: db })).rejects.toThrow(/not a yomi ledger/);
    await expect(importSqliteLedger({ sourcePath: path.join(dir, "missing.db"), target: db })).rejects.toThrow();
  });

  it("aborts on invalid JSON naming only the table, column and row count", async () => {
    const source = buildLedger({ rawOverride: "{not json: 秘密" });
    const db = await target();
    const err = await importSqliteLedger({ sourcePath: source, target: db }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ImportRefusedError);
    expect((err as Error).message).toContain("transactions.raw: 1 row(s)");
    expect((err as Error).message).not.toContain("秘密");
    const n = await queryRows<{ n: number }>(db, sql`select count(*)::int as n from transactions`);
    expect(n[0]!.n).toBe(0);
  });
});
