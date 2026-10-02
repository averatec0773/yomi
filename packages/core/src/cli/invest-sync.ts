// Manual holdings pull: `pnpm invest:sync [ibkr|plaid|all]` (DATABASE_URL picks the ledger, default the PGlite
// directory data/pglite, which the yomi server must not have open). Prints counts and per-currency totals only, never positions or account names.
import { closeDb } from "@yomi/db";
import { resolveIbkrSource } from "../invest/credentials";
import { syncHoldings, type InvestProviderChoice } from "../invest/sync";
import { formatMinorDecimal } from "../money";
import { resolvePlaidProvider } from "../sync/credentials";
import { getCurrentUser } from "../user";
import { loadRootEnv } from "./env";
import { openLedgerForCli } from "./open";

const arg = process.argv.slice(2).find((a) => !a.startsWith("--")) ?? "all";
if (!["ibkr", "plaid", "all"].includes(arg)) {
  console.error("usage: pnpm invest:sync [ibkr|plaid|all]");
  process.exit(1);
}

loadRootEnv();
const db = await openLedgerForCli();

try {
  const user = getCurrentUser();
  // Env first, then the credentials saved in Settings (same resolvers as the web server).
  const r = await syncHoldings(db, user, { provider: arg as InvestProviderChoice }, { ibkr: await resolveIbkrSource(db, user), plaid: await resolvePlaidProvider(db) });
  for (const x of r.results) {
    const totals = Object.entries(x.totals)
      .map(([cur, v]) => `${formatMinorDecimal(v, cur)} ${cur}`)
      .join(", ");
    const conn = x.connectionId != null ? ` connection #${x.connectionId}` : "";
    console.log(
      `${x.provider}${conn} as of ${x.asOf}: ${x.accounts} accounts, ${x.positions} positions, ${x.cashBalances} cash balances, ` +
        `${x.transactionsNew} new / ${x.transactionsUpdated} updated transactions, ${x.navDays} daily values; market value ${totals || "0"}` +
        (x.warnings.length ? `; ${x.warnings.length} warnings` : ""),
    );
    if (x.stale) console.log(`${x.provider}: stale, IBKR has not published the ${x.expectedAsOf} statement yet (received ${x.asOf}); the scheduler will retry`);
  }
  for (const s of r.skipped) console.log(`${s}: not configured, skipped`);
  for (const e of r.errors) {
    console.error(`${e.provider}${e.connectionId != null ? ` connection #${e.connectionId}` : ""}: ${e.code}`);
    process.exitCode = 1;
  }
} catch (e) {
  const code = (e as { code?: unknown }).code;
  console.error(typeof code === "string" ? `${code}: ${(e as Error).message}` : (e as Error).message);
  process.exitCode = 1;
}
await closeDb(db);
