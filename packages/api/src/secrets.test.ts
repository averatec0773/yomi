import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { IbkrTestResult, InvestConfig, InvestSyncResult, SecretsView, SettingsStatus } from "@yomi/contracts";
import { configureKeyFile, seed } from "@yomi/core";
import { userSettings } from "@yomi/db";
import { testDb } from "@yomi/db/testing";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApi } from "./index";
import { secureForSecrets } from "./secrets";

const xml = readFileSync(new URL("../../importers/test/fixtures/ibkr/flex-activity.xml", import.meta.url), "utf8");
const TOKEN = "test-token-3141-abcdefgh";
const QUERY = "123456";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "yomi-api-secrets-"));
  configureKeyFile(path.join(dir, "secret.key"));
  // Tests must not see the developer's own credentials.
  for (const k of ["IBKR_FLEX_TOKEN", "IBKR_FLEX_QUERY_ID", "PLAID_CLIENT_ID", "PLAID_SECRET", "PLAID_SECRET_SANDBOX", "PLAID_SECRET_PRODUCTION", "PLAID_ENV", "YOMI_SECRET_KEY"]) vi.stubEnv(k, "");
});
afterEach(() => {
  vi.unstubAllEnvs();
  configureKeyFile(null);
  rmSync(dir, { recursive: true, force: true });
});

async function setup(env: NodeJS.ProcessEnv = {}) {
  const db = await testDb();
  await seed(db);
  const lines: string[] = [];
  const flexCalls: string[] = [];
  const ibkrFetch = (async (url: string) => {
    const u = new URL(url);
    flexCalls.push(u.pathname.split("/").pop()!);
    if (u.searchParams.get("t") !== TOKEN) return new Response("<FlexStatementResponse><Status>Fail</Status><ErrorCode>1015</ErrorCode><ErrorMessage>Token is invalid.</ErrorMessage></FlexStatementResponse>");
    if (u.pathname.endsWith("SendRequest")) return new Response("<FlexStatementResponse><Status>Success</Status><ReferenceCode>9</ReferenceCode></FlexStatementResponse>");
    return new Response(xml);
  }) as unknown as typeof fetch;
  const plaidFetch = (async (_url: string, init: RequestInit) => {
    const b = JSON.parse(String(init.body)) as { secret: string };
    return b.secret === "good-secret-3141"
      ? new Response("{}")
      : new Response(JSON.stringify({ error_type: "INVALID_INPUT", error_code: "INVALID_API_KEYS", error_message: "invalid" }), { status: 400 });
  }) as unknown as typeof fetch;
  const app = createApi({
    getDb: () => db,
    invest: { ibkrFlex: { fetch: ibkrFetch, sleep: async () => {} }, fetch: (async () => new Response("[]")) as unknown as typeof fetch, now: () => new Date("2026-09-29T23:00:00Z") },
    secrets: { plaidFetch, log: (l) => lines.push(l), env },
    // The LAN and proxied hosts below must reach the secrets check, past the host allowlist.
    allowedHosts: ["192.168.1.20", "yomi.example.com"],
  });
  const req = (method: string, p: string, body?: unknown, headers: Record<string, string> = {}, host = "http://localhost") =>
    app.request(`${host}/api${p}`, { method, headers: { "Content-Type": "application/json", ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { db, req, lines, flexCalls };
}

describe("secureForSecrets", () => {
  it("allows loopback and HTTPS, refuses plain HTTP to a LAN address", () => {
    // Next.js hands route handlers its own origin as the URL; the Host header carries what the browser used.
    const next = (host: string, extra: { forwardedProto?: string; forwardedHost?: string } = {}) => secureForSecrets({ url: "http://localhost:3460/api/x", host, ...extra });
    expect(next("localhost:3460")).toBe(true);
    expect(next("127.0.0.1:3460")).toBe(true);
    expect(next("[::1]:3460")).toBe(true);
    expect(next("yomi.localhost:3460")).toBe(true);
    expect(next("192.168.1.20:3460")).toBe(false);
    expect(next("localhost.evil.com")).toBe(false);
    expect(next("yomi.example.com", { forwardedProto: "https" })).toBe(true);
    expect(next("yomi.example.com", { forwardedProto: "https, http" })).toBe(true);
    expect(next("yomi.example.com", { forwardedProto: "http" })).toBe(false);
    // A proxy on this machine that forwards a remote plain-HTTP visit.
    expect(next("localhost:3460", { forwardedHost: "192.168.1.20:7773" })).toBe(false);
    expect(secureForSecrets({ url: "https://yomi.example.com/api/x" })).toBe(true);
    expect(secureForSecrets({ url: "http://192.168.1.20:7773/api/x" })).toBe(false);
  });
});

describe("/api/settings/secrets", () => {
  it("is write-only for secrets: the view never carries a secret, only the identifiers' values", async () => {
    const { req, db } = await setup();
    const empty = SecretsView.parse(await (await req("GET", "/settings/secrets")).json());
    expect(empty.ibkr.token).toEqual({ configured: false, last4: null, source: null, unreadable: false });
    expect(empty.ibkr.queryId).toEqual({ configured: false, last4: null, source: null, unreadable: false, value: null });
    expect(empty.key).toEqual({ source: "none", state: "missing", file: path.join(dir, "secret.key") });

    const saved = await req("PUT", "/settings/secrets/ibkr", { token: TOKEN, queryId: QUERY, expiresOn: "2027-09-30" });
    expect(saved.status).toBe(200);
    const text = await saved.text();
    expect(text).not.toContain(TOKEN);
    const v = SecretsView.parse(JSON.parse(text));
    expect(v.ibkr).toMatchObject({ token: { configured: true, last4: "efgh", source: "settings" }, queryId: { configured: true, source: "settings", value: QUERY }, expiresOn: "2027-09-30" });
    // Checked on the raw JSON: the schema would strip an extra key.
    expect(Object.keys((JSON.parse(text) as SecretsView).ibkr.token).sort()).toEqual(["configured", "last4", "source", "unreadable"]);
    expect(v.key.source).toBe("file");
    expect(JSON.stringify(await db.select().from(userSettings))).not.toContain(TOKEN);
  });

  it("refuses to receive secrets over plain HTTP from a LAN address (403, calm code), allows HTTPS behind a proxy", async () => {
    const { req, lines } = await setup();
    const lan = await req("PUT", "/settings/secrets/ibkr", { token: TOKEN }, {}, "http://192.168.1.20:7773");
    expect(lan.status).toBe(403);
    expect(await lan.json()).toMatchObject({ code: "secrets_insecure_origin" });
    expect((await req("POST", "/settings/secrets/ibkr/test", { token: TOKEN, queryId: QUERY }, {}, "http://192.168.1.20:7773")).status).toBe(403);
    expect((await req("DELETE", "/settings/secrets/plaid/sandbox", undefined, {}, "http://192.168.1.20:7773")).status).toBe(403);
    expect(lines).toEqual([]);
    const proxied = await req("PUT", "/settings/secrets/ibkr", { token: TOKEN }, { "x-forwarded-proto": "https" }, "http://yomi.example.com");
    expect(proxied.status).toBe(200);
  });

  it("tests IBKR through SendRequest and GetStatement, and a saved token applies without a restart", async () => {
    const { req, lines, flexCalls } = await setup();
    expect(InvestConfig.parse(await (await req("GET", "/invest/config")).json()).ibkr.configured).toBe(false);

    const bad = await req("POST", "/settings/secrets/ibkr/test", { token: "wrong-token-0000", queryId: QUERY });
    expect(bad.status).toBe(409);
    expect(await bad.json()).toMatchObject({ code: "invest_ibkr_token_invalid" });
    const ok = await req("POST", "/settings/secrets/ibkr/test", { token: TOKEN, queryId: QUERY });
    const body = await ok.json();
    expect(body).toMatchObject({ ok: true, statementDate: "2026-09-28", positions: 4, accounts: 1 });
    expect(IbkrTestResult.parse(body).sections.filter((x) => x.state !== "present").map((x) => x.id)).toEqual(["nav"]);
    expect(flexCalls).toEqual(["SendRequest", "SendRequest", "GetStatement"]);

    await req("PUT", "/settings/secrets/ibkr", { token: TOKEN, queryId: QUERY });
    expect(InvestConfig.parse(await (await req("GET", "/invest/config")).json()).ibkr.configured).toBe(true);
    // The test above ran before the query was saved: nothing recorded for the row.
    expect(SettingsStatus.parse(await (await req("GET", "/settings/status")).json()).ibkr.sectionCheck).toBeNull();
    const sync = InvestSyncResult.parse(await (await req("POST", "/invest/sync", { provider: "ibkr" })).json());
    expect(sync.results[0]).toMatchObject({ provider: "ibkr", asOf: "2026-09-28", positions: 4 });
    expect(lines.filter((l) => l.includes("audit")).map((l) => l.replace(/ at .*$/, ""))).toEqual([
      "[yomi] audit: user 1 set ibkr_flex_token",
      "[yomi] audit: user 1 set ibkr_flex_query_id",
    ]);

    const removed = SecretsView.parse(await (await req("DELETE", "/settings/secrets/ibkr")).json());
    expect(removed.ibkr.token.configured).toBe(false);
    expect(InvestConfig.parse(await (await req("GET", "/invest/config")).json()).ibkr.configured).toBe(false);
  });

  it("Test connection with no fields tests the saved token and query and records the sections for the row", async () => {
    const { req, flexCalls } = await setup();
    expect((await req("POST", "/settings/secrets/ibkr/test", {})).status).toBe(400);
    expect(flexCalls).toEqual([]);
    await req("PUT", "/settings/secrets/ibkr", { token: TOKEN, queryId: QUERY });
    const status = async () => SettingsStatus.parse(await (await req("GET", "/settings/status")).json()).ibkr;
    expect((await status()).sectionCheck).toBeNull();

    const res = await req("POST", "/settings/secrets/ibkr/test", {});
    expect(res.status).toBe(200);
    const body = IbkrTestResult.parse(await res.json());
    expect(body).toMatchObject({ statementDate: "2026-09-28", positions: 4 });
    expect(body.sections.map((x) => [x.id, x.state])).toEqual([
      ["accountInformation", "present"],
      ["openPositions", "present"],
      ["cashReport", "present"],
      ["trades", "present"],
      ["cashTransactions", "present"],
      ["nav", "missing"],
    ]);
    const check = (await status()).sectionCheck!;
    expect(check.from).toBe(check.to);
    expect(check.sections).toEqual(body.sections);
    expect(JSON.stringify(check)).not.toContain(QUERY);

    // Trying another query ID leaves the saved query's record alone.
    expect((await req("POST", "/settings/secrets/ibkr/test", { queryId: "999999" })).status).toBe(200);
    expect((await status()).sectionCheck).toEqual(check);

    // Sync now records too: the first sync is a 365-day window.
    await req("POST", "/invest/sync", { provider: "ibkr" });
    const synced = (await status()).sectionCheck!;
    expect([synced.from < synced.to, synced.sections.find((x) => x.id === "nav")?.state]).toEqual([true, "missing"]);
  });

  it("env values win and cannot be overwritten", async () => {
    const { req } = await setup({ IBKR_FLEX_TOKEN: "env-token-55015501", PLAID_CLIENT_ID: "env-client-5501" });
    const v = SecretsView.parse(await (await req("GET", "/settings/secrets")).json());
    expect(v.ibkr.token.source).toBe("env");
    expect(v.plaid.clientId).toMatchObject({ configured: true, source: "env", last4: "5501", value: null });
    const res = await req("PUT", "/settings/secrets/ibkr", { token: TOKEN });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: "secret_set_by_env", params: { name: "IBKR_FLEX_TOKEN" } });
    // The expiry date can still be saved for an env token.
    expect((await req("PUT", "/settings/secrets/ibkr", { expiresOn: "2027-01-01" })).status).toBe(200);
  });

  it("tests Plaid keys per environment, then saves them at instance level and bank config picks them up", async () => {
    const { req } = await setup();
    expect(((await (await req("GET", "/bank/config")).json()) as { configured: boolean }).configured).toBe(false);
    const incomplete = await req("POST", "/settings/secrets/plaid/test", { environment: "sandbox" });
    expect(await incomplete.json()).toMatchObject({ code: "secrets_plaid_incomplete" });
    expect(await (await req("POST", "/settings/secrets/plaid/test", { environment: "sandbox", clientId: "client-3141", secret: "bad-secret-0000" })).json()).toMatchObject({ ok: false, code: "INVALID_API_KEYS" });
    expect(await (await req("POST", "/settings/secrets/plaid/test", { environment: "sandbox", clientId: "client-3141", secret: "good-secret-3141" })).json()).toEqual({ ok: true });

    const v = SecretsView.parse(await (await req("PUT", "/settings/secrets/plaid", { clientId: "client-3141", sandbox: "good-secret-3141", defaultEnvironment: "sandbox" })).json());
    expect(v.plaid).toMatchObject({ clientId: { configured: true, source: "settings", value: "client-3141" }, sandbox: { configured: true, last4: "3141" }, production: { configured: false }, defaultEnvironment: { value: "sandbox", source: "settings" } });
    // Secrets never come back, identifiers do.
    const raw = (await (await req("GET", "/settings/secrets")).json()) as SecretsView;
    expect(Object.keys(raw.plaid.sandbox).sort()).toEqual(["configured", "last4", "source", "unreadable"]);
    expect(JSON.stringify(raw)).not.toContain("good-secret-3141");
    expect(await (await req("GET", "/bank/config")).json()).toMatchObject({ configured: true, environments: ["sandbox"], defaultEnvironment: "sandbox" });
    // A stored secret is reused when the test sends none.
    expect(await (await req("POST", "/settings/secrets/plaid/test", { environment: "sandbox" })).json()).toEqual({ ok: true });

    expect((await req("DELETE", "/settings/secrets/plaid/nope")).status).toBe(400);
    const after = SecretsView.parse(await (await req("DELETE", "/settings/secrets/plaid/sandbox")).json());
    expect(after.plaid.sandbox.configured).toBe(false);
    expect(((await (await req("GET", "/bank/config")).json()) as { configured: boolean }).configured).toBe(false);
  });
});
