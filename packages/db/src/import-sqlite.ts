import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { getTableColumns, getTableName, is, sql } from "drizzle-orm";
import { getTableConfig, PgTable } from "drizzle-orm/pg-core";
import { type Db, listTables, migrate, queryRows } from "./client";
import { findRepoRoot, migrationsFolder } from "./paths";
import * as schema from "./schema";

// One-way copy of a yomi v0.1.x SQLite ledger into an empty Postgres (PGlite or server) database, then a
// verification that compares aggregates of both sides. Reports never carry row contents: only counts, sums,
// months, currencies and setting key names.

/** A refusal that leaves the target untouched (not a ledger, schema behind, target not empty, schema drift). */
export class ImportRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ImportRefusedError";
  }
}

export interface ImportCheck {
  section: string;
  key: string;
  source: string;
  target: string;
  ok: boolean;
}

export interface ImportReport {
  ok: boolean;
  /** Tables copied, in insertion (foreign key) order. */
  tables: string[];
  rowsCopied: number;
  checks: ImportCheck[];
  /** Distinct user_settings keys found in the target. */
  settingKeys: string[];
}

/** SQLite internals and drizzle's migration log: not ledger tables. */
function isInternalTable(name: string): boolean {
  return name.startsWith("sqlite_") || name === "__drizzle_migrations";
}

/** The archived SQLite migrations: the schema of existing v0.1.x ledgers. */
export function sqliteMigrationsFolder(): string {
  return path.join(findRepoRoot(), "packages", "db", "migrations-sqlite");
}

/** Tables added after v0.1: a v0.1 ledger has none of them, so the import leaves them empty. */
const POSTGRES_ONLY_TABLES = new Set(["investment_daily_nav"]);

/** Nullable columns added after v0.1 (`table.column`): a v0.1 ledger has none of them, so the import leaves them null. */
const POSTGRES_ONLY_COLUMNS = new Set(["import_batches.period_start", "import_batches.period_end"]);

/** The ledger tables a v0.1 ledger also has (Postgres-only tables left out). */
function schemaTables(): Map<string, PgTable> {
  const m = new Map<string, PgTable>();
  for (const v of Object.values(schema)) if (is(v, PgTable) && !POSTGRES_ONLY_TABLES.has(getTableName(v))) m.set(getTableName(v), v);
  return m;
}

/** Tables ordered so every referenced table comes before the tables referencing it (self references ignored). */
function foreignKeyOrder(tables: Map<string, PgTable>): string[] {
  const deps = new Map<string, Set<string>>();
  for (const [name, t] of tables) {
    const d = new Set<string>();
    for (const fk of getTableConfig(t).foreignKeys) {
      const ref = getTableName(fk.reference().foreignTable);
      if (ref !== name) d.add(ref);
    }
    deps.set(name, d);
  }
  const order: string[] = [];
  const done = new Set<string>();
  while (order.length < tables.size) {
    const ready = [...deps].filter(([n, d]) => !done.has(n) && [...d].every((x) => done.has(x))).map(([n]) => n);
    if (ready.length === 0) throw new Error("foreign key cycle between ledger tables");
    for (const n of ready.sort()) {
      order.push(n);
      done.add(n);
    }
  }
  return order;
}

/** Columns of `t` that reference `t` itself (transactions.duplicate_of_id). */
function selfReferences(t: PgTable): string[] {
  const name = getTableName(t);
  return getTableConfig(t)
    .foreignKeys.filter((fk) => getTableName(fk.reference().foreignTable) === name)
    .flatMap((fk) => fk.reference().columns.map((c) => c.name));
}

function quoteIdent(s: string): string {
  return `"${s.replace(/"/g, '""')}"`;
}

function sqliteTables(src: Database.Database): string[] {
  return (src.prepare("select name from sqlite_master where type = 'table' order by name").all() as { name: string }[])
    .map((r) => r.name)
    .filter((n) => !isInternalTable(n));
}

/** Refuses a file that is not a yomi ledger or whose schema is behind the archived SQLite migrations. */
function checkSourceSchema(src: Database.Database, folder: string): void {
  const names = new Set((src.prepare("select name from sqlite_master where type = 'table'").all() as { name: string }[]).map((r) => r.name));
  if (!names.has("__drizzle_migrations") || !names.has("transactions") || !names.has("user_settings")) {
    throw new ImportRefusedError("The source is not a yomi ledger (no migration log or ledger tables found).");
  }
  const journal = JSON.parse(readFileSync(path.join(folder, "meta", "_journal.json"), "utf8")) as { entries: { when: number; tag: string }[] };
  const last = journal.entries.at(-1);
  const applied = src.prepare("select max(created_at) as m from __drizzle_migrations").get() as { m: number | null };
  if (last && (applied.m === null || Number(applied.m) < last.when)) {
    throw new ImportRefusedError(
      `The source ledger's schema is behind yomi v0.1.x (its last migration predates ${last.tag}). ` +
        "Open it once with yomi v0.1.x so it finishes its migrations, then run this import again.",
    );
  }
}

async function countRows(db: Db, table: string): Promise<number> {
  const r = await queryRows<{ n: number }>(db, sql.raw(`select count(*)::int as n from ${quoteIdent(table)}`));
  return r[0]?.n ?? 0;
}

type Converter = (v: unknown) => unknown;

/** Maps one SQLite column value to what the Drizzle column takes; throws "invalid" markers counted by the caller. */
function converterFor(columnType: string): Converter {
  if (columnType === "PgBoolean") {
    return (v) => {
      if (v === null || v === undefined) return null;
      if (v === 1 || v === 1n) return true;
      if (v === 0 || v === 0n) return false;
      throw new InvalidValue();
    };
  }
  if (columnType === "PgJsonb" || columnType === "PgJson") {
    return (v) => {
      if (v === null || v === undefined) return null;
      if (typeof v !== "string") throw new InvalidValue();
      try {
        return JSON.parse(v);
      } catch {
        throw new InvalidValue();
      }
    };
  }
  if (columnType === "PgBigInt53" || columnType === "PgInteger") {
    return (v) => {
      if (v === null || v === undefined) return null;
      if (typeof v === "bigint") {
        if (v > BigInt(Number.MAX_SAFE_INTEGER) || v < BigInt(Number.MIN_SAFE_INTEGER)) throw new InvalidValue();
        return Number(v);
      }
      if (typeof v !== "number" || !Number.isInteger(v)) throw new InvalidValue();
      return v;
    };
  }
  return (v) => {
    if (v === null || v === undefined) return null;
    if (typeof v !== "string") throw new InvalidValue();
    return v;
  };
}

class InvalidValue extends Error {}

/** Postgres's bind parameter limit is 65535 per statement. */
const MAX_PARAMS = 60000;

/**
 * Copies every ledger table of the SQLite file at `sourcePath` into `target` (in one transaction, ids
 * preserved, identity sequences moved past the copied ids), then verifies both sides. `target` must be
 * empty; it is migrated first. Throws ImportRefusedError (nothing written) when the source is not a
 * current yomi ledger, the target already holds rows, or the table/column sets differ.
 */
export async function importSqliteLedger(opts: {
  sourcePath: string;
  target: Db;
  migrationsFolder?: string;
  sqliteMigrationsFolder?: string;
}): Promise<ImportReport> {
  const src = new Database(opts.sourcePath, { readonly: true, fileMustExist: true });
  try {
    checkSourceSchema(src, opts.sqliteMigrationsFolder ?? sqliteMigrationsFolder());

    for (const t of await listTables(opts.target)) {
      if ((await countRows(opts.target, t)) > 0) {
        throw new ImportRefusedError(`The target database is not empty (table ${t} has rows). Import only into an empty database.`);
      }
    }
    await migrate(opts.target, opts.migrationsFolder ?? migrationsFolder());

    const drizzleTables = schemaTables();
    const targetTables = (await listTables(opts.target)).filter((t) => !POSTGRES_ONLY_TABLES.has(t));
    const sourceTables = sqliteTables(src);
    const missingInTarget = sourceTables.filter((t) => !targetTables.includes(t));
    const missingInSource = targetTables.filter((t) => !sourceTables.includes(t));
    const noSchema = targetTables.filter((t) => !drizzleTables.has(t));
    if (missingInTarget.length || missingInSource.length || noSchema.length) {
      throw new ImportRefusedError(
        `Table sets differ. Only in the source: [${missingInTarget.join(", ")}]; only in the target: [${missingInSource.join(", ")}]; ` +
          `target tables without a schema definition: [${noSchema.join(", ")}].`,
      );
    }

    const order = foreignKeyOrder(drizzleTables);
    const plans = order.map((name) => {
      const table = drizzleTables.get(name)!;
      const srcCols = (src.prepare(`select name from pragma_table_info(?)`).all(name) as { name: string }[]).map((c) => c.name);
      const cols = Object.entries(getTableColumns(table))
        .filter(([, col]) => !POSTGRES_ONLY_COLUMNS.has(`${name}.${col.name}`))
        .map(([key, col]) => ({ key, name: col.name, convert: converterFor(col.columnType) }));
      const onlySource = srcCols.filter((c) => !cols.some((x) => x.name === c));
      const onlyTarget = cols.filter((c) => !srcCols.includes(c.name)).map((c) => c.name);
      if (onlySource.length || onlyTarget.length) {
        throw new ImportRefusedError(`Columns of ${name} differ. Only in the source: [${onlySource.join(", ")}]; only in the target: [${onlyTarget.join(", ")}].`);
      }
      return { name, table, cols, selfRefs: selfReferences(table) };
    });

    // Read and convert everything before writing, so a bad value aborts with nothing written.
    const prepared = plans.map((p) => {
      const stmt = src.prepare(`select * from ${quoteIdent(p.name)} order by rowid`).safeIntegers(true);
      const raw = stmt.all() as Record<string, unknown>[];
      const invalid = new Map<string, number>();
      const later: { id: number; col: string; value: number }[] = [];
      const rows = raw.map((r) => {
        const out: Record<string, unknown> = {};
        for (const c of p.cols) {
          let v: unknown;
          try {
            v = c.convert(r[c.name]);
          } catch (e) {
            if (!(e instanceof InvalidValue)) throw e;
            invalid.set(c.name, (invalid.get(c.name) ?? 0) + 1);
            continue;
          }
          if (p.selfRefs.includes(c.name) && v !== null) {
            later.push({ id: Number(r.id), col: c.name, value: v as number });
            v = null;
          }
          out[c.key] = v;
        }
        return out;
      });
      if (invalid.size) {
        const detail = [...invalid].map(([c, n]) => `${p.name}.${c}: ${n} row(s)`).join("; ");
        throw new ImportRefusedError(`The source has values that cannot be converted (${detail}). Nothing was written.`);
      }
      return { ...p, rows, later };
    });

    let rowsCopied = 0;
    await opts.target.transaction(async (tx) => {
      for (const p of prepared) {
        const size = Math.max(1, Math.floor(MAX_PARAMS / p.cols.length));
        for (let i = 0; i < p.rows.length; i += size) {
          await tx.insert(p.table).values(p.rows.slice(i, i + size) as never);
        }
        rowsCopied += p.rows.length;
      }
      // Self references in a second pass, as raw SQL so no $onUpdateFn bumps updated_at.
      for (const p of prepared) {
        for (const col of new Set(p.later.map((l) => l.col))) {
          const pairs = p.later.filter((l) => l.col === col);
          for (let i = 0; i < pairs.length; i += 10000) {
            const values = sql.join(
              pairs.slice(i, i + 10000).map((l) => sql`(${l.id}::int, ${l.value}::int)`),
              sql`, `,
            );
            await tx.execute(
              sql`update ${sql.raw(quoteIdent(p.name))} set ${sql.raw(quoteIdent(col))} = v.ref from (values ${values}) as v(id, ref) where ${sql.raw(quoteIdent(p.name))}.id = v.id`,
            );
          }
        }
      }
      for (const p of prepared) {
        const t = quoteIdent(p.name);
        await tx.execute(
          sql.raw(`select setval(pg_get_serial_sequence('${t.replace(/'/g, "''")}', 'id'), coalesce(max(id), 1), max(id) is not null) from ${t}`),
        );
      }
    });

    const verified = await verifyAgainstSource(src, opts.target);
    return { ...verified, tables: order, rowsCopied };
  } finally {
    src.close();
  }
}

/** Runs the aggregate comparison of a SQLite ledger file against a target database (after an import). */
export async function verifySqliteImport(opts: { sourcePath: string; target: Db }): Promise<ImportReport> {
  const src = new Database(opts.sourcePath, { readonly: true, fileMustExist: true });
  try {
    const verified = await verifyAgainstSource(src, opts.target);
    return { ...verified, tables: foreignKeyOrder(schemaTables()), rowsCopied: 0 };
  } finally {
    src.close();
  }
}

type Agg = Map<string, string[]>;

function sqliteAgg(src: Database.Database, query: string): Agg {
  const rows = src.prepare(query).safeIntegers(true).raw(true).all() as unknown[][];
  return new Map(rows.map((r) => [String(r[0] ?? ""), r.slice(1).map((v) => String(v ?? 0))]));
}

async function pgAgg(db: Db, query: string): Promise<Agg> {
  // Columns are aliased k, a, b, c: an object row keeps one value per column name.
  const rows = await queryRows<Record<string, unknown>>(db, sql.raw(query));
  return new Map(rows.map((r) => [String(r.k ?? ""), ["a", "b", "c"].filter((c) => c in r).map((c) => String(r[c] ?? 0))]));
}

function compareAgg(section: string, a: Agg, b: Agg, width: number): ImportCheck[] {
  const keys = [...new Set([...a.keys(), ...b.keys()])].sort();
  if (keys.length === 0) return [{ section, key: "(no rows)", source: "0", target: "0", ok: true }];
  return keys.map((key) => {
    // Through BigInt: exact for any integer, and a side without the key counts as zeros.
    const zeros = Array.from({ length: width }, () => "0");
    const s = (a.get(key) ?? zeros).map((x) => BigInt(x).toString());
    const t = (b.get(key) ?? zeros).map((x) => BigInt(x).toString());
    return { section, key, source: s.join(" / "), target: t.join(" / "), ok: s.join() === t.join() };
  });
}

function digest(rows: { id: unknown; value: unknown }[]): string {
  const h = createHash("sha256");
  for (const r of rows) h.update(`${JSON.stringify([String(r.id), r.value])}\n`);
  return h.digest("hex");
}

async function verifyAgainstSource(src: Database.Database, db: Db): Promise<Omit<ImportReport, "tables" | "rowsCopied">> {
  const checks: ImportCheck[] = [];
  // Row counts per table.
  const srcNames = new Set(sqliteTables(src));
  const dstNames = new Set((await listTables(db)).filter((t) => !POSTGRES_ONLY_TABLES.has(t)));
  const tables = [...new Set([...srcNames, ...dstNames])].sort();
  for (const t of tables) {
    const s = srcNames.has(t) ? String((src.prepare(`select count(*) as n from ${quoteIdent(t)}`).get() as { n: number }).n) : "absent";
    const d = dstNames.has(t) ? String(await countRows(db, t)) : "absent";
    checks.push({ section: "rows", key: t, source: s, target: d, ok: s === d });
  }

  // Aggregates; the SQL is identical on both sides except the casts Postgres needs for exact text output.
  const both = async (section: string, sqliteQ: string, pgQ: string, width: number) =>
    checks.push(...compareAgg(section, sqliteAgg(src, sqliteQ), await pgAgg(db, pgQ), width));

  await both(
    "transactions (month currency: count / amount sum)",
    "select substr(occurred_on, 1, 7) || ' ' || currency, count(*), coalesce(sum(amount_minor), 0) from transactions group by 1",
    "select substr(occurred_on, 1, 7) || ' ' || currency as k, count(*)::text as a, coalesce(sum(amount_minor), 0)::text as b from transactions group by 1",
    2,
  );
  await both(
    "splits (month currency: count / owed sum / paid sum)",
    "select substr(t.occurred_on, 1, 7) || ' ' || s.currency, count(*), coalesce(sum(s.owed_minor), 0), coalesce(sum(s.paid_minor), 0) from transaction_splits s join transactions t on t.id = s.transaction_id group by 1",
    "select substr(t.occurred_on, 1, 7) || ' ' || s.currency as k, count(*)::text as a, coalesce(sum(s.owed_minor), 0)::text as b, coalesce(sum(s.paid_minor), 0)::text as c from transaction_splits s join transactions t on t.id = s.transaction_id group by 1",
    3,
  );
  await both(
    "settlements (month currency: count / amount sum)",
    "select substr(settled_on, 1, 7) || ' ' || currency, count(*), coalesce(sum(amount_minor), 0) from settlements group by 1",
    "select substr(settled_on, 1, 7) || ' ' || currency as k, count(*)::text as a, coalesce(sum(amount_minor), 0)::text as b from settlements group by 1",
    2,
  );
  await both(
    "holdings (currency: count / market value sum)",
    "select currency, count(*), coalesce(sum(market_value_minor), 0) from holding_snapshots group by 1",
    "select currency as k, count(*)::text as a, coalesce(sum(market_value_minor), 0)::text as b from holding_snapshots group by 1",
    2,
  );
  await both(
    "balance snapshots (count)",
    "select 'all', count(*) from account_balance_snapshots",
    "select 'all' as k, count(*)::text as a from account_balance_snapshots",
    1,
  );

  // Secrets and other encrypted text: sha256 over the ordered (id, value) pairs; only the verdict is reported.
  for (const [table, col] of [
    ["user_settings", "value"],
    ["bank_connections", "access_token"],
  ] as const) {
    const q = `select id, ${col} as value from ${table} order by id`;
    const s = src.prepare(q).safeIntegers(true).all() as { id: unknown; value: unknown }[];
    const d = await queryRows<{ id: unknown; value: unknown }>(db, sql.raw(q));
    const same = s.length === d.length && digest(s) === digest(d);
    checks.push({
      section: "secrets (sha256 of id + value)",
      key: `${table}.${col}`,
      source: `${s.length} rows`,
      target: `${d.length} rows, ${same ? "identical" : "DIFFERENT"}`,
      ok: same,
    });
  }

  const srcKeys = (src.prepare("select distinct key from user_settings order by key").all() as { key: string }[]).map((r) => r.key);
  const settingKeys = (await queryRows<{ key: string }>(db, sql`select distinct key from user_settings`)).map((r) => r.key);
  const sortedSrc = [...srcKeys].sort();
  const sortedDst = settingKeys.sort();
  checks.push({
    section: "user_settings keys",
    key: "distinct keys",
    source: String(srcKeys.length),
    target: String(settingKeys.length),
    ok: sortedSrc.join("\n") === sortedDst.join("\n"),
  });

  return { ok: checks.every((c) => c.ok), checks, settingKeys: sortedDst };
}

/** A compact, aggregates-only table of the report, one marker per line and a summary line at the end. */
export function formatImportReport(report: ImportReport): string {
  const lines: string[] = [];
  let section = "";
  const w = Math.max(...report.checks.map((c) => c.key.length), 10);
  for (const c of report.checks) {
    if (c.section !== section) {
      section = c.section;
      lines.push("", section);
    }
    lines.push(`  ${c.ok ? "ok      " : "MISMATCH"}  ${c.key.padEnd(w)}  source ${c.source}  ->  target ${c.target}`);
  }
  lines.push("", `user_settings keys copied (${report.settingKeys.length}): ${report.settingKeys.join(", ") || "none"}`);
  const bad = report.checks.filter((c) => !c.ok).length;
  lines.push(
    "",
    report.ok
      ? `OK: ${report.tables.length} tables, ${report.rowsCopied} rows copied; all ${report.checks.length} checks match.`
      : `FAILED: ${bad} of ${report.checks.length} checks do not match.`,
  );
  return lines.join("\n").replace(/^\n/, "");
}

