import {
  type ApiError,
  IbkrSaveInput,
  IbkrTestInput,
  type IbkrTestResult,
  PlaidKeyField,
  PlaidSaveInput,
  PlaidTestInput,
  type PlaidTestResult,
  type SecretsView,
} from "@yomi/contracts";
import {
  type FlexOptions,
  getCurrentUser,
  ibkrSecretsView,
  InvestError,
  plaidSecretsView,
  removeIbkrCredentials,
  removePlaidKey,
  resolveIbkrCredentials,
  resolvePlaidCredentials,
  saveIbkrCredentials,
  savePlaidKeys,
  SecretKeyError,
  secretKeyInfo,
  SecretSettingError,
  testIbkrCredentials,
  testPlaidKeys,
} from "@yomi/core";
import type { Db } from "@yomi/db";
import { type Context, Hono } from "hono";
import { BadRequest, errorBody, readJson } from "./split";

export interface SecretsDeps {
  getDb: () => Db | Promise<Db>;
  /** Flex client options: fetch and timing (tests and the YOMI_E2E hook inject a fake service). */
  ibkrFlex?: FlexOptions;
  /** fetch for Plaid's /institutions/get (tests inject a fake). */
  plaidFetch?: typeof fetch;
  /** Audit and key file log lines (default console.log). Never receives a value. */
  log?: (line: string) => void;
  env?: NodeJS.ProcessEnv;
}

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

/** The hostname of a Host header value ("192.168.1.20:7773", "[::1]:7773", "localhost"), lower case, without the port. */
function hostnameOf(host: string): string {
  const h = host.split(",")[0]!.trim().toLowerCase();
  if (h.startsWith("[")) return h.slice(0, h.indexOf("]") + 1);
  return h.replace(/:\d+$/, "");
}

export interface SecretsRequestInfo {
  url: string;
  /** The Host header. Next.js builds the request URL from its own origin, so the header is what tells a LAN visit apart. */
  host?: string | null;
  forwardedHost?: string | null;
  forwardedProto?: string | null;
}

/**
 * Whether a request may carry a secret: over HTTPS (the URL, or `x-forwarded-proto` from a proxy that terminates
 * TLS) or to a loopback host (`x-forwarded-host`, else the Host header, else the URL). A LAN address over plain HTTP
 * is refused, so a token is never sent in cleartext across the network by accident. These headers are the
 * client's, so this is not access control (YOMI_ACCESS_TOKEN is); it keeps honest browsers from leaking secrets.
 */
export function secureForSecrets(req: SecretsRequestInfo): boolean {
  const u = new URL(req.url);
  const proto = req.forwardedProto?.split(",")[0]?.trim().toLowerCase() || u.protocol.replace(":", "");
  if (proto === "https") return true;
  const host = hostnameOf(req.forwardedHost || req.host || u.host);
  return LOCAL_HOSTS.has(host) || host.endsWith(".localhost");
}

class InsecureOrigin extends BadRequest {}

function assertSecure(c: Context): void {
  const info = { url: c.req.url, host: c.req.header("host"), forwardedHost: c.req.header("x-forwarded-host"), forwardedProto: c.req.header("x-forwarded-proto") };
  if (!secureForSecrets(info)) {
    throw new InsecureOrigin("secrets_insecure_origin", "Secrets can be saved only on this computer (localhost) or over HTTPS");
  }
}

/**
 * Routes under /api/settings/secrets: the write-only view, test, save and remove for IBKR (per user) and the
 * Plaid developer keys (instance). Every route that receives or uses a secret needs localhost or HTTPS.
 */
export function secretsRoutes(deps: SecretsDeps): Hono {
  const r = new Hono();
  const env = () => deps.env ?? process.env;
  const log = (line: string) => (deps.log ?? console.log)(line);

  r.onError((err, c) => {
    if (err instanceof InsecureOrigin) return c.json(errorBody(err), 403);
    if (err instanceof BadRequest) return c.json(errorBody(err), 400);
    if (err instanceof SecretSettingError) return c.json(errorBody(err), 409);
    if (err instanceof SecretKeyError) return c.json(errorBody(err), 409);
    if (err instanceof InvestError) {
      const status =
        err.code === "invest_ibkr_rate_limited"
          ? 429
          : err.code.startsWith("invest_ibkr_token") || err.code === "invest_ibkr_query_invalid" || err.code === "invest_ibkr_ip_restricted"
            ? 409
            : err.code === "invest_ibkr_test_timeout"
              ? 504
              : 502;
      return c.json(errorBody(err), status);
    }
    throw err;
  });

  const view = async (): Promise<SecretsView> => {
    const db = await deps.getDb();
    const k = secretKeyInfo(env());
    return { ibkr: await ibkrSecretsView(db, getCurrentUser(), env()), plaid: await plaidSecretsView(db, env()), key: { source: k.source, state: k.state, file: k.file } };
  };

  r.get("/", async (c) => {
    c.header("Cache-Control", "no-store");
    return c.json((await view()) satisfies SecretsView);
  });

  r.post("/ibkr/test", async (c) => {
    assertSecure(c);
    const body = await readJson(c, IbkrTestInput);
    const db = await deps.getDb();
    const user = getCurrentUser();
    const current = await resolveIbkrCredentials(db, user, env());
    const token = body.token ?? current.token.value;
    const queryId = body.queryId ?? current.queryId.value;
    if (!token || !queryId) throw new BadRequest("secrets_ibkr_incomplete", "Enter the Flex token and the query ID first");
    // On the saved query the sections it had are recorded (the row shows them); a query being tried out is not.
    const saved = queryId.trim() === current.queryId.value?.trim();
    const out = await testIbkrCredentials(token, queryId, deps.ibkrFlex, undefined, saved ? { q: db, user } : undefined);
    return c.json({ ok: true, ...out } satisfies IbkrTestResult);
  });

  r.put("/ibkr", async (c) => {
    assertSecure(c);
    const body = await readJson(c, IbkrSaveInput);
    await saveIbkrCredentials(await deps.getDb(), getCurrentUser(), body, env(), log);
    return c.json((await view()) satisfies SecretsView);
  });

  r.delete("/ibkr", async (c) => {
    assertSecure(c);
    await removeIbkrCredentials(await deps.getDb(), getCurrentUser(), log);
    return c.json((await view()) satisfies SecretsView);
  });

  r.post("/plaid/test", async (c) => {
    assertSecure(c);
    const body = await readJson(c, PlaidTestInput);
    const current = await resolvePlaidCredentials(await deps.getDb(), env());
    const clientId = body.clientId ?? current.clientId.value;
    const secret = body.secret ?? current[body.environment].value;
    if (!clientId || !secret) throw new BadRequest("secrets_plaid_incomplete", "Enter the client ID and the secret for this environment first");
    const out = await testPlaidKeys({ clientId, secret, environment: body.environment }, { fetch: deps.plaidFetch });
    return c.json(out satisfies PlaidTestResult);
  });

  r.put("/plaid", async (c) => {
    assertSecure(c);
    const body = await readJson(c, PlaidSaveInput);
    await savePlaidKeys(await deps.getDb(), body, env(), log, getCurrentUser());
    return c.json((await view()) satisfies SecretsView);
  });

  r.delete("/plaid/:field", async (c) => {
    assertSecure(c);
    const field = PlaidKeyField.safeParse(c.req.param("field"));
    if (!field.success) {
      return c.json({ error: "field must be clientId, sandbox or production", code: "validation_failed", params: { details: "field" } } satisfies ApiError, 400);
    }
    await removePlaidKey(await deps.getDb(), field.data, log, getCurrentUser());
    return c.json((await view()) satisfies SecretsView);
  });

  return r;
}
