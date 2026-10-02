import type { Health } from "@yomi/contracts";
import { type CurrentUser, localUser, type ParseFn, runWithUser } from "@yomi/core";
import type { Db } from "@yomi/db";
import { detectAndParse } from "@yomi/importers";
import { type Context, Hono } from "hono";
import { accessRoutes } from "./access";
import { analysisRoutes } from "./analysis";
import { assetsRoutes } from "./assets";
import { captureRoutes } from "./capture";
import { type BankDeps, bankRoutes } from "./bank";
import { importRoutes } from "./import";
import { type InvestDeps, investRoutes } from "./invest";
import { ledgerRoutes } from "./ledger";
import { maintenanceRoutes } from "./maintenance";
import { monthRoutes } from "./month";
import { quickRoutes } from "./quick";
import { type SecretsDeps, secretsRoutes } from "./secrets";
import { splitRoutes } from "./split";

export interface ApiDeps {
  /** Process-wide DB handle, owned by the host app (apps/web/lib/db.ts). */
  getDb: () => Db | Promise<Db>;
  /** Statement parser; defaults to @yomi/importers detectAndParse. Tests inject a fake. */
  parse?: ParseFn;
  /** Bank sync config and provider; default to the Plaid setup read from env. */
  bank?: BankDeps;
  /** IBKR source, FX fetch and clock for /api/invest; Plaid defaults to bank.provider. */
  invest?: InvestDeps;
  /** Settings > secrets: fetch fakes for tests, the audit log sink. */
  secrets?: Omit<SecretsDeps, "getDb">;
  /** Local 'YYYY-MM-DD' that stats presets resolve against; tests pin it. */
  today?: () => string;
  /** Resolves the acting user per request; defaults to resolveRequestUser. Tests inject one. */
  resolveUser?: (c: Context) => CurrentUser | Promise<CurrentUser>;
}

/**
 * The acting user for one API request. LOCAL_MODE: always user 1. A session lookup (cookie or bearer to user id)
 * replaces this body once auth lands; nothing else changes, since core reads the user through getCurrentUser().
 */
export function resolveRequestUser(_c: Context): CurrentUser {
  return localUser();
}

export function createApi(deps: ApiDeps) {
  const app = new Hono().basePath("/api");
  app.get("/health", (c) => c.json({ ok: true } satisfies Health));
  app.route("/", accessRoutes());
  const resolveUser = deps.resolveUser ?? resolveRequestUser;
  // Every route below runs with the request's user in scope (core's getCurrentUser() reads it).
  app.use(async (c, next) => {
    const user = await resolveUser(c);
    await runWithUser(user, () => next());
  });
  app.route("/import", importRoutes({ getDb: deps.getDb, parse: deps.parse ?? detectAndParse }));
  app.route("/", ledgerRoutes({ getDb: deps.getDb }));
  app.route("/", monthRoutes({ getDb: deps.getDb, today: deps.today }));
  app.route("/", analysisRoutes({ getDb: deps.getDb, today: deps.today }));
  app.route("/", splitRoutes({ getDb: deps.getDb }));
  app.route("/quick", quickRoutes({ getDb: deps.getDb }));
  app.route("/", captureRoutes({ getDb: deps.getDb, today: deps.today }));
  app.route("/", maintenanceRoutes({ getDb: deps.getDb }));
  app.route("/bank", bankRoutes({ getDb: deps.getDb, ...deps.bank }));
  app.route("/settings/secrets", secretsRoutes({ getDb: deps.getDb, ibkrFlex: deps.invest?.ibkrFlex, ...deps.secrets }));
  app.route("/invest", investRoutes({ getDb: deps.getDb, plaid: deps.bank?.provider, ...deps.invest }));
  app.route("/", assetsRoutes({
    getDb: deps.getDb,
    plaid: deps.bank?.provider,
    ibkr: deps.invest?.ibkr,
    ibkrFlex: deps.invest?.ibkrFlex,
    fetch: deps.invest?.fetch,
    now: deps.invest?.now,
  }));
  return app;
}

/** Fetch-style handler for mounting inside Next.js route handlers. */
export function createHandler(deps: ApiDeps): (req: Request) => Response | Promise<Response> {
  const app = createApi(deps);
  return (req) => app.fetch(req);
}
