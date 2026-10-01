import {
  type ApiError,
  IBKR_HISTORY_DAYS,
  IbkrHistoryBody,
  type InvestAccountList,
  type InvestConfig,
  type InvestOverview,
  InvestOverviewQuery,
  InvestSyncBody,
  type InvestSyncResult,
} from "@yomi/contracts";
import {
  type BankProvider,
  BankProviderError,
  convertOverview,
  getCurrentUser,
  getFxRates,
  type IbkrConfig,
  type FlexOptions,
  type IbkrSource,
  InvestError,
  type InvestErrorCode,
  brokerageConnectionCount,
  listInvestmentAccounts,
  overviewCurrencies,
  resolveIbkrConfig,
  resolveIbkrSource,
  resolvePlaidConfig,
  resolvePlaidProvider,
  portfolioOverview,
  pullIbkrHistory,
  SecretKeyError,
  syncHoldings,
} from "@yomi/core";
import type { Db } from "@yomi/db";
import { Hono } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { BadRequest, errorBody, readJson, readQuery } from "./split";

export interface InvestDeps {
  /** IBKR Flex source (env, then Settings, resolved per request); tests inject a fake. */
  ibkr?: () => IbkrSource | null | Promise<IbkrSource | null>;
  /** Flex client options for the default IBKR source (the YOMI_E2E hook injects a fake Flex service). */
  ibkrFlex?: FlexOptions;
  ibkrConfig?: () => IbkrConfig | Promise<IbkrConfig>;
  /** Plaid provider (shared with bank sync); tests inject a fake. */
  plaid?: () => BankProvider | null | Promise<BankProvider | null>;
  /** fetch for Frankfurter; tests inject a fake. */
  fetch?: typeof fetch;
  now?: () => Date;
}

const INVEST_ERROR_STATUS: Record<InvestErrorCode, ContentfulStatusCode> = {
  invest_ibkr_not_configured: 409,
  invest_ibkr_token_expired: 409,
  invest_ibkr_token_invalid: 409,
  invest_ibkr_query_invalid: 409,
  invest_ibkr_ip_restricted: 409,
  invest_ibkr_rate_limited: 429,
  invest_ibkr_unavailable: 502,
  invest_ibkr_error: 502,
  invest_ibkr_statement_invalid: 502,
  invest_ibkr_range_invalid: 400,
  invest_ibkr_history_days_invalid: 400,
  invest_ibkr_pull_too_soon: 429,
  invest_ibkr_pull_backoff: 429,
  invest_ibkr_pull_running: 409,
  invest_flex_in_progress_timeout: 504,
  invest_plaid_not_configured: 409,
  invest_plaid_error: 502,
  invest_fx_unavailable: 502,
  invest_fx_currency_unsupported: 400,
};

/** Routes under /api/invest: config, accounts, overview, sync, ibkr/history. Read-only holdings; no trading, no advice. */
export function investRoutes(deps: { getDb: () => Db | Promise<Db> } & InvestDeps): Hono {
  const r = new Hono();
  const getIbkr = deps.ibkr ?? (async () => await resolveIbkrSource(await deps.getDb(), getCurrentUser(), process.env, deps.ibkrFlex));
  const getIbkrConfig = deps.ibkrConfig ?? (async () => await resolveIbkrConfig(await deps.getDb(), getCurrentUser()));
  const getPlaid = deps.plaid ?? (async () => await resolvePlaidProvider(await deps.getDb()));

  r.onError((err, c) => {
    if (err instanceof BadRequest) return c.json(errorBody(err), 400);
    if (err instanceof InvestError) return c.json(errorBody(err), INVEST_ERROR_STATUS[err.code]);
    if (err instanceof SecretKeyError) return c.json(errorBody(err), 409);
    if (err instanceof BankProviderError) {
      const body: ApiError = { error: err.message, code: `bank_provider_${err.kind}`, params: { detail: err.message } };
      return c.json(body, 502);
    }
    throw err;
  });

  r.get("/config", async (c) => {
    const db = await deps.getDb();
    const user = getCurrentUser();
    const ib = await getIbkrConfig();
    const brokerageConnections = await brokerageConnectionCount(db, user);
    const plaidConfigured = deps.plaid ? (await deps.plaid()) != null : (await resolvePlaidConfig(db)).configured;
    return c.json({
      ibkr: { configured: ib.configured, missing: ib.missing },
      plaid: { configured: plaidConfigured, brokerageConnections },
      fx: { source: "frankfurter" },
    } satisfies InvestConfig);
  });

  r.get("/accounts", async (c) => c.json({ accounts: await listInvestmentAccounts(await deps.getDb(), getCurrentUser()) } satisfies InvestAccountList));

  r.get("/overview", async (c) => {
    const q = readQuery(c, InvestOverviewQuery);
    const db = await deps.getDb();
    const user = getCurrentUser();
    const o = await portfolioOverview(db, user, { asOf: q.asOf });
    let fxError: InvestOverview["fxError"] = null;
    if (q.currency && o.totals.length) {
      try {
        const fx = await getFxRates(db, user, [...overviewCurrencies(o), q.currency], { fetch: deps.fetch, now: deps.now });
        o.converted = convertOverview(o, q.currency, fx);
      } catch (e) {
        if (!(e instanceof InvestError)) throw e;
        fxError = { code: e.code, params: e.params, message: e.message };
      }
    }
    return c.json({ ...o, fxError } satisfies InvestOverview);
  });

  r.post("/sync", async (c) => {
    const text = await c.req.text();
    const body = text.trim() ? await readJson(c, InvestSyncBody) : InvestSyncBody.parse({});
    const out = await syncHoldings(await deps.getDb(), getCurrentUser(), { provider: body.provider }, { ibkr: await getIbkr(), plaid: await getPlaid(), now: deps.now });
    return c.json(out satisfies InvestSyncResult);
  });

  /** "Pull history": the last `days` days of IBKR activity (1 to 365); refused while too soon after the last pull. */
  r.post("/ibkr/history", async (c) => {
    const text = await c.req.text();
    let raw: unknown;
    try {
      raw = text.trim() ? JSON.parse(text) : {};
    } catch {
      throw new BadRequest("invalid_json", "The request body is not valid JSON");
    }
    const body = IbkrHistoryBody.safeParse(raw);
    if (!body.success) {
      throw new InvestError("invest_ibkr_history_days_invalid", "days must be a whole number from 1 to 365", { min: IBKR_HISTORY_DAYS.min, max: IBKR_HISTORY_DAYS.max });
    }
    const out = await pullIbkrHistory(await deps.getDb(), getCurrentUser(), { days: body.data.days }, { ibkr: await getIbkr(), now: deps.now });
    return c.json(out satisfies InvestSyncResult);
  });

  return r;
}
