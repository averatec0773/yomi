import {
  type BankConfig as BankConfigView,
  type BankConnectionList,
  type BankConnectionView,
  type BankSyncResult,
  DisconnectBody,
  disconnectConfirmMatches,
  disconnectConfirmText,
  type EnrollmentResult,
  ExchangeBody,
  LinkExitBody,
  LinkRecoverBody,
  type LinkRecoveryResult,
  LinkTokenBody,
  type LinkTokenResult,
} from "@yomi/contracts";
import {
  type BankConfig,
  type BankProvider,
  connectWithPublicToken,
  createLinkToken,
  disconnectConnection,
  getConnectionSummary,
  getCurrentUser,
  listConnections,
  resolvePlaidConfig,
  resolvePlaidProvider,
  plaidSecretVar,
  pauseConnection,
  recoverLinkSessions,
  resumeConnection,
  CodedError,
  syncConnection,
  syncHoldings,
} from "@yomi/core";
import type { Db } from "@yomi/db";
import { Hono } from "hono";
import { BadRequest, idParam, readJson } from "./http";

export interface BankDeps {
  /** Plaid setup (env, then Settings); tests inject their own. */
  config?: () => BankConfig | Promise<BankConfig>;
  /** Provider built from the config, or null when not configured. Tests inject a fake. */
  provider?: () => BankProvider | null | Promise<BankProvider | null>;
  /** Server-side log line sink (default console.log). */
  log?: (line: string) => void;
}

/** Routes under /api/bank: config, link token, public token exchange, connections, sync, pause/resume, disconnect. */
export function bankRoutes(deps: { getDb: () => Db | Promise<Db> } & BankDeps): Hono {
  const r = new Hono();
  // Resolved per request (env, then Settings > Developer keys), so saved keys apply without a restart.
  const config = deps.config ?? (async () => await resolvePlaidConfig(await deps.getDb()));
  const getProvider = deps.provider ?? (async () => await resolvePlaidProvider(await deps.getDb()));

  async function provider(): Promise<BankProvider> {
    const p = await getProvider();
    if (!p) {
      const missing = (await config()).missing.join(", ");
      throw new CodedError("conflict", "bank_not_configured", `Bank sync is not configured yet; missing: ${missing}`, { missing });
    }
    return p;
  }

  function assertAvailable(p: BankProvider, environment: string): void {
    if (!p.environments.includes(environment)) {
      const environments = p.environments.join(", ");
      const secretVar = plaidSecretVar(environment);
      throw new BadRequest(
        "bank_environment_not_configured",
        `environment must be a configured one: ${environments} (missing ${secretVar})`,
        { environments, secretVar },
      );
    }
  }

  const connections = async (db: Db) => (await listConnections(db, getCurrentUser(), await getProvider())) as BankConnectionView[];

  r.get("/config", async (c) => {
    const { provider: p, configured, defaultEnvironment, environments, missing } = await config();
    return c.json({ provider: p, configured, defaultEnvironment, environments, missing } satisfies BankConfigView);
  });

  r.get("/connections", async (c) => c.json({ connections: await connections(await deps.getDb()) } satisfies BankConnectionList));

  r.post("/link-token", async (c) => {
    const body = await readJson(c, LinkTokenBody, { optional: true });
    const p = await provider();
    if (body.environment && body.connectionId == null) assertAvailable(p, body.environment);
    const out = await createLinkToken(await deps.getDb(), getCurrentUser(), p, {
      connectionId: body.connectionId,
      environment: body.environment,
      kind: body.purpose === "brokerage" ? "brokerage" : "bank",
    });
    return c.json(out satisfies LinkTokenResult);
  });

  /** Plaid Link closed with an error or was abandoned: one log line so the reason is visible in the dev server output. */
  r.post("/link-exit", async (c) => {
    const b = await readJson(c, LinkExitBody);
    const parts = [b.errorCode ?? (b.kind === "exit" ? "(no error code)" : "ERROR"), b.institution, b.status, b.linkSessionId];
    const line = `[yomi] Plaid Link ${b.kind === "exit" ? "exit" : "error"}: ${parts.filter(Boolean).join(" ")}`;
    (deps.log ?? console.log)(b.errorMessage ? `${line} (${b.errorMessage})` : line);
    return c.json({ ok: true as const });
  });

  r.post("/exchange", async (c) => {
    const body = await readJson(c, ExchangeBody);
    const p = await provider();
    if (body.environment) assertAvailable(p, body.environment);
    const db = await deps.getDb();
    const user = getCurrentUser();
    const connection = await connectWithPublicToken(db, user, p, {
      publicToken: body.public_token,
      environment: body.environment,
      institutionName: body.institution?.name ?? null,
      linkSessionId: body.sessionId,
    });
    // The login is stored before anything else can fail: from here on problems are warnings (200),
    // so the UI shows the connection with "sync now" / "reconnect" instead of losing it. A retried
    // exchange (same public token) reuses the stored connection and calls Plaid no further.
    let sync: BankSyncResult | null = null;
    let syncError: string | null = null;
    if (connection.reused) {
      syncError = connection.lastError;
    } else if (connection.status === "error") {
      syncError = connection.lastError ?? "Reading the accounts failed";
    } else if (connection.kind === "brokerage") {
      // Holdings, not transactions: one pull right away so the Assets page has data.
      const r = await syncHoldings(db, user, { provider: "plaid" }, { plaid: p }).catch((e: unknown) => ({
        errors: [{ message: e instanceof Error ? e.message : String(e) }],
      }));
      syncError = r.errors.map((e) => e.message).join("; ") || null;
    } else {
      try {
        sync = await syncConnection(db, user, p, connection.id);
      } catch (e) {
        syncError = e instanceof Error ? e.message : String(e);
      }
    }
    const fresh = (await connections(db)).find((x) => x.id === connection.id) ?? (connection as BankConnectionView);
    return c.json({ connection: fresh, sync, syncError } satisfies EnrollmentResult);
  });

  r.post("/link-sessions/recover", async (c) => {
    const body = await readJson(c, LinkRecoverBody, { optional: true });
    const out = await recoverLinkSessions(await deps.getDb(), getCurrentUser(), await provider(), {
      sessionId: body.sessionId,
      linkSessionId: body.linkSessionId,
    });
    const log = deps.log ?? console.log;
    for (const r of out.recovered) log(`[yomi] Recovered an unfinished bank connection: ${r.institutionName ?? "bank"} (connection #${r.connectionId})`);
    for (const s of out.sessions) if (s.error) log(`[yomi] Recovering Link session #${s.id} failed: ${s.error}`);
    return c.json(out satisfies LinkRecoveryResult);
  });

  r.post("/connections/:id/sync", async (c) => {
    const out = await syncConnection(await deps.getDb(), getCurrentUser(), await provider(), idParam(c));
    return c.json(out satisfies BankSyncResult);
  });

  // Local only: nothing is sent to Plaid, the Item and its Trial slot stay.
  r.post("/connections/:id/pause", async (c) => c.json((await pauseConnection(await deps.getDb(), getCurrentUser(), idParam(c), await getProvider())) as BankConnectionView));
  r.post("/connections/:id/resume", async (c) => c.json((await resumeConnection(await deps.getDb(), getCurrentUser(), idParam(c), await getProvider())) as BankConnectionView));

  // /item/remove cannot be undone and does not return the Trial slot: the body must repeat the
  // institution name exactly, so a stray request or a UI bug cannot delete a connection.
  r.delete("/connections/:id", async (c) => {
    const id = idParam(c);
    const db = await deps.getDb();
    const user = getCurrentUser();
    const conn = await getConnectionSummary(db, user, id, await getProvider());
    const confirm = disconnectConfirmText(conn.institutionName);
    const unconfirmed = () =>
      new BadRequest("bank_disconnect_confirm", `Deleting this connection needs a confirmation in the request body: { "confirm": "${confirm}" }`, {
        confirm,
      });
    const body = await readJson(c, DisconnectBody, { optional: true, invalid: unconfirmed });
    if (!disconnectConfirmMatches(conn.institutionName, body.confirm)) throw unconfirmed();
    const out = await disconnectConnection(db, user, await provider(), id);
    return c.json(out as BankConnectionView);
  });

  return r;
}
