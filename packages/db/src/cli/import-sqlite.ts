// `pnpm db:import-sqlite <path-to-yomi.db> [--target <pglite dir | postgres url>]`: copies a yomi v0.1.x SQLite
// ledger into an empty Postgres database (default DATABASE_URL, else data/pglite) and verifies the copy.
import { existsSync, statSync } from "node:fs";
import path from "node:path";
import { closeDb, createDb, type Db } from "../client";
import { formatImportReport, importSqliteLedger, ImportRefusedError } from "../import-sqlite";
import { DbLockedError } from "../lock";
import { defaultDatabaseUrl, redactUrl, resolveDbTarget } from "../paths";

const USAGE = "usage: pnpm db:import-sqlite <path-to-yomi.db> [--target <pglite directory | memory:// | postgres://...>]";

/** pnpm runs scripts from the package directory; INIT_CWD is where the user typed the command. */
const userCwd = process.env.INIT_CWD || process.cwd();

function parseArgs(argv: string[]): { source: string; target: string | null } | null {
  let source: string | null = null;
  let target: string | null = null;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--") continue;
    if (a === "--target") {
      target = argv[++i] ?? null;
      if (!target) return null;
    } else if (a.startsWith("--target=")) target = a.slice("--target=".length);
    else if (a.startsWith("-") || source !== null) return null;
    else source = a;
  }
  return source ? { source, target } : null;
}

/** A relative PGlite directory given on the command line resolves from the user's directory, like the source. */
function targetUrl(target: string | null): string {
  if (!target) return defaultDatabaseUrl();
  if (/^(postgres(ql)?|memory):\/\//i.test(target) || target.startsWith("file:") || path.isAbsolute(target)) return target;
  return path.resolve(userCwd, target);
}

function describe(url: string): string {
  const t = resolveDbTarget(url);
  return t.kind === "server" ? redactUrl(t.url) : t.kind === "pglite" ? t.dataDir : "memory://";
}

const args = parseArgs(process.argv.slice(2));
if (!args) {
  console.error(USAGE);
  process.exit(1);
}
const source = path.resolve(userCwd, args.source);
const url = targetUrl(args.target);
if (!existsSync(source) || !statSync(source).isFile()) {
  console.error(`No SQLite ledger at ${source}.\n${USAGE}`);
  process.exit(1);
}

let db: Db | null = null;
try {
  db = await createDb(url, { allowBesideLegacy: true });
  console.log(`Importing ${source}\n     into ${describe(url)}\n`);
  const report = await importSqliteLedger({ sourcePath: source, target: db });
  console.log(formatImportReport(report));
  if (!report.ok) process.exitCode = 1;
} catch (e) {
  if (e instanceof DbLockedError || e instanceof ImportRefusedError) console.error(e.message);
  else console.error(`import failed: ${e instanceof Error ? e.message : String(e)}`);
  process.exitCode = 1;
} finally {
  if (db) await closeDb(db);
}
