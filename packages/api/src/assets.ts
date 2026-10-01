import { type AssetsSyncResult, NetWorthQuery, type NetWorthView, StartingBalanceBody, type StartingBalanceResult } from "@yomi/contracts";
import {
  AssetsError,
  type BankProvider,
  getCurrentUser,
  type FlexOptions,
  type IbkrSource,
  netWorth,
  resolveIbkrSource,
  resolvePlaidProvider,
  SecretKeyError,
  setStartingBalance,
  syncAll,
  syncHoldings,
  writeDailyBalanceSnapshots,
} from "@yomi/core";
import type { Db } from "@yomi/db";
import { Hono } from "hono";
import { BadRequest, errorBody, idParam, readJson, readQuery } from "./split";

export interface AssetsDeps {
  getDb: () => Db | Promise<Db>;
  /** Plaid provider (bank balances and brokerages); tests inject a fake. */
  plaid?: () => BankProvider | null | Promise<BankProvider | null>;
  ibkr?: () => IbkrSource | null | Promise<IbkrSource | null>;
  /** Flex client options for the default IBKR source (the YOMI_E2E hook). */
  ibkrFlex?: FlexOptions;
  /** fetch for Frankfurter; tests inject a fake. */
  fetch?: typeof fetch;
  now?: () => Date;
}

/** /api/assets/net-worth, /api/assets/sync and /api/accounts/:id/starting-balance. */
export function assetsRoutes(deps: AssetsDeps): Hono {
  const r = new Hono();
  const getPlaid = deps.plaid ?? (async () => await resolvePlaidProvider(await deps.getDb()));
  const getIbkr = deps.ibkr ?? (async () => await resolveIbkrSource(await deps.getDb(), getCurrentUser(), process.env, deps.ibkrFlex));

  r.onError((err, c) => {
    if (err instanceof BadRequest) return c.json(errorBody(err), 400);
    if (err instanceof AssetsError) return c.json(errorBody(err), err.kind === "not_found" ? 404 : 400);
    if (err instanceof SecretKeyError) return c.json(errorBody(err), 409);
    throw err;
  });

  r.get("/assets/net-worth", async (c) => {
    const q = readQuery(c, NetWorthQuery);
    const out = await netWorth(await deps.getDb(), getCurrentUser(), q, { fetch: deps.fetch, now: deps.now });
    return c.json(out satisfies NetWorthView);
  });

  r.put("/accounts/:id/starting-balance", async (c) => {
    const id = idParam(c);
    const body = await readJson(c, StartingBalanceBody);
    const a = await setStartingBalance(await deps.getDb(), getCurrentUser(), id, "clear" in body ? null : body);
    const startingBalance = a.startingBalanceMinor != null && a.startingBalanceOn ? { amountMinor: a.startingBalanceMinor, on: a.startingBalanceOn } : null;
    return c.json({ id: a.id, startingBalance } satisfies StartingBalanceResult);
  });

  // Manual "Sync now" on /assets: bank connections (balances come with each sync), holdings, today's snapshots.
  r.post("/assets/sync", async (c) => {
    const db = await deps.getDb();
    const user = getCurrentUser();
    const plaid = await getPlaid();
    let bank: AssetsSyncResult["bank"] = null;
    if (plaid) {
      const out = await syncAll(db, user, plaid, { now: deps.now });
      bank = { connections: out.results.length, inserted: out.results.reduce((n, x) => n + x.inserted, 0), errors: out.errors };
    }
    const invest = await syncHoldings(db, user, { provider: "all" }, { ibkr: await getIbkr(), plaid, now: deps.now });
    await writeDailyBalanceSnapshots(db, user, { now: deps.now, force: true });
    return c.json({ bank, invest } satisfies AssetsSyncResult);
  });

  return r;
}
