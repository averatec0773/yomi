import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { type Db, userSettings } from "@yomi/db";
import { mapFlexStatement } from "@yomi/importers";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  ibkrSecretsView,
  removeIbkrCredentials,
  resolveIbkrConfig,
  resolveIbkrCredentials,
  resolveIbkrSource,
  saveIbkrCredentials,
  testIbkrCredentials,
  tokenExpiry,
} from "../invest/credentials";
import { ibkrStatus } from "../invest/status";
import { freshDb, user } from "../ledger/test-helpers";
import { decryptSecret, generateSecretKey, isEncrypted, parseSecretKey } from "../secrets/crypto";
import { activeSecretKey, configureKeyFile, createKeyFile, defaultKeyFilePath, ensureSecretKey, readKeyFile, secretKeyInfo } from "../secrets/keyfile";
import { secretsHealth } from "../secrets/tokens";
import { plaidSecretsView, removePlaidKey, resolvePlaidConfig, resolvePlaidProvider, savePlaidKeys, testPlaidKeys } from "../sync/credentials";
import { INSTANCE_USER, SecretSettingError } from "./secrets";
import { readSetting } from "./store";

const TOKEN = "test-token-3141-abcdefgh";
const QUERY = "123456";
let dir: string;
let lines: string[];
const log = (l: string) => lines.push(l);

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "yomi-keyfile-"));
  lines = [];
  configureKeyFile(path.join(dir, "cfg", "secret.key"));
});
afterEach(() => {
  configureKeyFile(null);
  rmSync(dir, { recursive: true, force: true });
});

const allSettings = async (db: Db) => (await db.select().from(userSettings)).filter((r) => /^(ibkr|plaid)_/.test(r.key));

describe("key file", () => {
  it("defaults outside the data directory, overridable by YOMI_SECRET_KEY_FILE", () => {
    expect(defaultKeyFilePath({ XDG_CONFIG_HOME: "/cfg" })).toBe(path.join("/cfg", "yomi", "secret.key"));
    expect(defaultKeyFilePath({ YOMI_SECRET_KEY_FILE: "/k/x.key", XDG_CONFIG_HOME: "/cfg" })).toBe("/k/x.key");
  });

  it("is created on first need with 0600 in a 0700 directory, then reused; never when YOMI_SECRET_KEY is set", () => {
    const file = path.join(dir, "cfg", "secret.key");
    expect(secretKeyInfo({})).toEqual({ source: "none", state: "missing", file });
    const envKey = generateSecretKey();
    expect(ensureSecretKey({ YOMI_SECRET_KEY: envKey }, log)).toEqual(parseSecretKey(envKey));
    expect(() => statSync(file)).toThrow();

    const k = ensureSecretKey({}, log);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(statSync(path.dirname(file)).mode & 0o777).toBe(0o700);
    expect(readKeyFile(file)).toEqual(k);
    expect(ensureSecretKey({}, log)).toEqual(k);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain(file);
    expect(lines[0]).not.toContain(k.toString("base64"));
    expect(secretKeyInfo({})).toEqual({ source: "file", state: "present", file });
    // Env wins over the file.
    expect(activeSecretKey({ YOMI_SECRET_KEY: envKey })).toEqual(parseSecretKey(envKey));
    expect(secretKeyInfo({ YOMI_SECRET_KEY: envKey }).source).toBe("env");
  });

  it("loads an existing file on start, tightens loose permissions, reports a malformed one", () => {
    const file = path.join(dir, "k.key");
    const k = createKeyFile(file);
    configureKeyFile(file);
    expect(activeSecretKey({})).toEqual(k);
    writeFileSync(file, "not a key", { mode: 0o644 });
    configureKeyFile(file);
    expect(activeSecretKey({})).toBeNull();
    expect(secretKeyInfo({}).state).toBe("malformed");
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(() => ensureSecretKey({}, log)).toThrow(/malformed/);
  });

  it("without a configured key file, saving refuses instead of storing plaintext", async () => {
    configureKeyFile(null);
    const db = await freshDb();
    await expect(saveIbkrCredentials(db, user, { token: TOKEN }, {}, log)).rejects.toThrow(expect.objectContaining({ code: "bank_secret_missing" }));
    expect(await allSettings(db)).toEqual([]);
  });
});

describe("IBKR credentials", () => {
  it("stores token and query id encrypted (round trip), never plaintext, and audits without values", async () => {
    const db = await freshDb();
    await saveIbkrCredentials(db, user, { token: TOKEN, queryId: QUERY, expiresOn: "2027-09-30" }, {}, log);
    const stored = (await readSetting(db, user, "ibkr_flex_token"))!;
    expect(isEncrypted(stored)).toBe(true);
    expect(JSON.stringify(await allSettings(db))).not.toContain(TOKEN);
    expect(decryptSecret(stored, activeSecretKey({}))).toBe(TOKEN);
    expect(await readSetting(db, user, "ibkr_flex_token_expires_on")).toBe("2027-09-30");
    expect(await resolveIbkrCredentials(db, user, {})).toMatchObject({ token: { value: TOKEN, source: "settings" }, queryId: { value: QUERY, source: "settings" } });
    const audit = lines.filter((l) => l.includes("audit"));
    expect(audit.map((l) => l.replace(/ at .*$/, ""))).toEqual([
      "[yomi] audit: user 1 set ibkr_flex_token",
      "[yomi] audit: user 1 set ibkr_flex_query_id",
      "[yomi] audit: user 1 set ibkr_flex_token_expires_on",
    ]);
    expect(lines.join("\n")).not.toContain(TOKEN);
  });

  it("resolves env > settings > none per field", async () => {
    const db = await freshDb();
    expect(await resolveIbkrConfig(db, user, {})).toEqual({ configured: false, missing: ["IBKR_FLEX_TOKEN", "IBKR_FLEX_QUERY_ID"] });
    expect(await resolveIbkrSource(db, user, {})).toBeNull();
    await saveIbkrCredentials(db, user, { token: TOKEN, queryId: QUERY }, {}, log);
    expect(await resolveIbkrConfig(db, user, {})).toEqual({ configured: true, missing: [] });
    const env = { IBKR_FLEX_TOKEN: "env-token-99990000" };
    const c = await resolveIbkrCredentials(db, user, env);
    expect([c.token.value, c.token.source, c.queryId.source]).toEqual(["env-token-99990000", "env", "settings"]);
    const v = await ibkrSecretsView(db, user, env);
    expect(v.token).toEqual({ configured: true, last4: "0000", source: "env", unreadable: false });
    // The query ID is an identifier, not a secret: its value comes back.
    expect(v.queryId).toEqual({ configured: true, last4: null, source: "settings", unreadable: false, value: QUERY });
    expect(JSON.stringify(v)).not.toContain("env-token");
    // A field set by env cannot be saved over.
    await expect(saveIbkrCredentials(db, user, { token: "other-token-1234" }, env, log)).rejects.toThrow(SecretSettingError);
    // Status follows the resolver: set up from Settings.
    expect((await ibkrStatus(db, user, {})).configured).toBe(true);
    await removeIbkrCredentials(db, user, log);
    expect((await resolveIbkrConfig(db, user, {})).configured).toBe(false);
    expect(lines.at(-1)).toMatch(/audit: user 1 removed ibkr_flex_query_id at /);
  });

  it("a saved token the key cannot open reads as unreadable, not configured", async () => {
    const db = await freshDb();
    await saveIbkrCredentials(db, user, { token: TOKEN, queryId: QUERY }, {}, log);
    configureKeyFile(path.join(dir, "other.key"));
    createKeyFile(path.join(dir, "other.key"));
    const v = await ibkrSecretsView(db, user, {});
    expect(v.token).toEqual({ configured: false, last4: null, source: "settings", unreadable: true });
    expect(v.queryId).toEqual({ configured: false, last4: null, source: "settings", unreadable: true, value: null });
    expect(await resolveIbkrSource(db, user, {})).toBeNull();
  });

  it("test connection runs SendRequest then GetStatement (with retries) and reports the statement date and positions", async () => {
    const xml = readFileSync(new URL("../../../importers/test/fixtures/ibkr/flex-activity.xml", import.meta.url), "utf8");
    const calls: string[] = [];
    let polls = 0;
    const fetch = (async (url: string) => {
      const u = new URL(url);
      calls.push(`${u.pathname.split("/").pop()} q=${u.searchParams.get("q")}`);
      if (u.pathname.endsWith("SendRequest")) return new Response("<FlexStatementResponse><Status>Success</Status><ReferenceCode>77</ReferenceCode></FlexStatementResponse>");
      if (polls++ === 0) return new Response("<FlexStatementResponse><Status>Warn</Status><ErrorCode>1019</ErrorCode><ErrorMessage>in progress</ErrorMessage></FlexStatementResponse>");
      return new Response(xml);
    }) as unknown as typeof globalThis.fetch;
    const out = await testIbkrCredentials(TOKEN, QUERY, { fetch, sleep: async () => {} });
    expect(out).toEqual({ statementDate: "2026-09-28", positions: 4, accounts: 1 });
    expect(calls).toEqual(["SendRequest q=123456", "GetStatement q=77", "GetStatement q=77"]);
    expect(mapFlexStatement(xml).asOf).toBe("2026-09-28");

    const expired = (async () => new Response("<FlexStatementResponse><Status>Fail</Status><ErrorCode>1012</ErrorCode><ErrorMessage>Token has expired.</ErrorMessage></FlexStatementResponse>")) as unknown as typeof globalThis.fetch;
    await expect(testIbkrCredentials(TOKEN, QUERY, { fetch: expired, sleep: async () => {} })).rejects.toMatchObject({ code: "invest_ibkr_token_expired" });
  });

  it("expiry: none, ok, soon from 14 days before (0 = today), expired after", async () => {
    expect(tokenExpiry(null, "2026-09-30")).toEqual({ state: "none", days: null });
    expect(tokenExpiry("2026-10-15", "2026-09-30")).toEqual({ state: "ok", days: 15 });
    expect(tokenExpiry("2026-10-14", "2026-09-30")).toEqual({ state: "soon", days: 14 });
    expect(tokenExpiry("2026-09-30", "2026-09-30")).toEqual({ state: "soon", days: 0 });
    expect(tokenExpiry("2026-09-29", "2026-09-30")).toEqual({ state: "expired", days: -1 });
    const db = await freshDb();
    await saveIbkrCredentials(db, user, { expiresOn: "2026-10-05" }, {}, log);
    expect((await ibkrSecretsView(db, user, {}, new Date("2026-09-30T12:00:00Z"))).expiry).toEqual({ state: "soon", days: 5 });
    await saveIbkrCredentials(db, user, { expiresOn: null }, {}, log);
    expect((await ibkrSecretsView(db, user, {})).expiresOn).toBeNull();
  });
});

describe("Plaid developer keys", () => {
  it("are instance level (user 0), encrypted, env > settings > none per field", async () => {
    const db = await freshDb();
    expect(await resolvePlaidConfig(db, {})).toMatchObject({ configured: false, missing: ["PLAID_CLIENT_ID", "PLAID_SECRET_PRODUCTION / PLAID_SECRET_SANDBOX"] });
    await savePlaidKeys(db, { clientId: "client-id-3141", sandbox: "sandbox-secret-3141", defaultEnvironment: "sandbox" }, {}, log);
    const rows = await allSettings(db);
    expect(rows.every((r) => r.userId === INSTANCE_USER.id)).toBe(true);
    expect(rows.filter((r) => r.key !== "plaid_default_environment").every((r) => isEncrypted(r.value))).toBe(true);
    expect(await resolvePlaidConfig(db, {})).toMatchObject({ configured: true, environments: ["sandbox"], defaultEnvironment: "sandbox" });
    expect((await resolvePlaidProvider(db, {}))!.environments).toEqual(["sandbox"]);

    const env = { PLAID_CLIENT_ID: "env-client-5501", PLAID_SECRET: "legacy-prod-secret", PLAID_ENV: "production" };
    const v = await plaidSecretsView(db, env);
    // A client ID from env stays on the server; one saved in Settings comes back.
    expect(v.clientId).toMatchObject({ source: "env", last4: "5501", value: null });
    expect((await plaidSecretsView(db, {})).clientId).toMatchObject({ source: "settings", value: "client-id-3141" });
    expect(v.production).toMatchObject({ configured: true, source: "env" });
    expect(v.production).not.toHaveProperty("value");
    expect(JSON.stringify(v)).not.toContain("legacy-prod-secret");
    expect(JSON.stringify(v)).not.toContain("sandbox-secret-3141");
    expect(v.sandbox).toMatchObject({ configured: true, source: "settings", last4: "3141" });
    expect(v.defaultEnvironment).toEqual({ value: "production", source: "env" });
    expect(await resolvePlaidConfig(db, env)).toMatchObject({ environments: ["production", "sandbox"], defaultEnvironment: "production" });
    await expect(savePlaidKeys(db, { clientId: "x-client-1234" }, env, log)).rejects.toThrow(SecretSettingError);
    await expect(savePlaidKeys(db, { defaultEnvironment: "sandbox" }, env, log)).rejects.toThrow(SecretSettingError);

    expect(await removePlaidKey(db, "sandbox", log)).toBe(true);
    expect(await removePlaidKey(db, "sandbox", log)).toBe(false);
    expect((await resolvePlaidConfig(db, {})).configured).toBe(false);
    expect(lines.join("\n")).not.toMatch(/sandbox-secret|client-id-3141/);
  });

  it("test keys calls /institutions/get count 1 and reports Plaid's error code", async () => {
    const bodies: unknown[] = [];
    const ok = (async (url: string, init: RequestInit) => {
      bodies.push([url, JSON.parse(String(init.body))]);
      return new Response("{}");
    }) as unknown as typeof fetch;
    expect(await testPlaidKeys({ clientId: "c", secret: "s", environment: "sandbox" }, { fetch: ok })).toEqual({ ok: true });
    expect(bodies[0]).toEqual(["https://sandbox.plaid.com/institutions/get", { client_id: "c", secret: "s", count: 1, offset: 0, country_codes: ["US"] }]);
    const bad = (async () =>
      new Response(JSON.stringify({ error_type: "INVALID_INPUT", error_code: "INVALID_API_KEYS", error_message: "invalid client_id or secret provided" }), { status: 400 })) as unknown as typeof fetch;
    expect(await testPlaidKeys({ clientId: "c", secret: "s", environment: "production" }, { fetch: bad })).toMatchObject({ ok: false, code: "INVALID_API_KEYS" });
    const down = (async () => {
      throw new Error("offline");
    }) as unknown as typeof fetch;
    expect(await testPlaidKeys({ clientId: "c", secret: "s", environment: "production" }, { fetch: down })).toMatchObject({ ok: false, code: "UNREACHABLE" });
  });
});

describe("secrets health", () => {
  it("reports the key file as the key source once created", async () => {
    const db = await freshDb();
    expect(await secretsHealth(db, {})).toMatchObject({ key: "missing", keySource: "none" });
    ensureSecretKey({}, log);
    expect(await secretsHealth(db, {})).toMatchObject({ key: "present", keySource: "file" });
  });
});
