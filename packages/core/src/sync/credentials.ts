import { checkPlaidKeys, PlaidApiError, type PlaidEnvironment } from "@yomi/importers";
import type { Db } from "@yomi/db";
import {
  auditSecretChange,
  type IdentifierFieldView,
  identifierView,
  INSTANCE_USER,
  readSecretSetting,
  removeSetting,
  resolveSecret,
  type ResolvedSecret,
  type SecretFieldView,
  SecretSettingError,
  type SecretSource,
  secretView,
  writeSecretSetting,
} from "../settings/secrets";
import { deleteSetting, type Q, readSetting, writeSetting } from "../settings/store";
import { type BankConfig, plaidConfig, plaidProviderFromEnv, plaidSecretVar } from "./config";
import type { BankProvider } from "./provider";

/**
 * Plaid developer keys saved in Settings (instance level, user id 0). Env variables win per field:
 * PLAID_CLIENT_ID, PLAID_SECRET_SANDBOX, PLAID_SECRET_PRODUCTION (or the legacy PLAID_SECRET for PLAID_ENV's
 * environment) and PLAID_ENV.
 */
export const PLAID_SETTINGS = {
  clientId: "plaid_client_id",
  sandbox: "plaid_secret_sandbox",
  production: "plaid_secret_production",
  defaultEnvironment: "plaid_default_environment",
} as const;
export type PlaidSecretField = "clientId" | "sandbox" | "production";

const ENVS: readonly PlaidEnvironment[] = ["production", "sandbox"];

function isEnvironment(v: string | null | undefined): v is PlaidEnvironment {
  return ENVS.includes((v ?? "").trim().toLowerCase() as PlaidEnvironment);
}

/** The env value of one field, including the legacy PLAID_SECRET for PLAID_ENV's environment (default sandbox). */
function envValue(env: NodeJS.ProcessEnv, field: PlaidSecretField): string | undefined {
  if (field === "clientId") return env.PLAID_CLIENT_ID?.trim() || undefined;
  const specific = env[plaidSecretVar(field)]?.trim();
  if (specific) return specific;
  const legacyEnv = isEnvironment(env.PLAID_ENV) ? env.PLAID_ENV!.trim().toLowerCase() : "sandbox";
  return legacyEnv === field ? env.PLAID_SECRET?.trim() || undefined : undefined;
}

export interface PlaidCredentials {
  clientId: ResolvedSecret;
  sandbox: ResolvedSecret;
  production: ResolvedSecret;
  defaultEnvironment: { value: PlaidEnvironment | null; source: SecretSource | null };
}

export async function resolvePlaidCredentials(q: Q, env: NodeJS.ProcessEnv = process.env): Promise<PlaidCredentials> {
  const field = async (f: PlaidSecretField) => resolveSecret(envValue(env, f), await readSecretSetting(q, INSTANCE_USER, PLAID_SETTINGS[f], env));
  const stored = await readSetting(q, INSTANCE_USER, PLAID_SETTINGS.defaultEnvironment);
  const defaultEnvironment: PlaidCredentials["defaultEnvironment"] = isEnvironment(env.PLAID_ENV)
    ? { value: env.PLAID_ENV!.trim().toLowerCase() as PlaidEnvironment, source: "env" }
    : isEnvironment(stored)
      ? { value: stored, source: "settings" }
      : { value: null, source: null };
  return { clientId: await field("clientId"), sandbox: await field("sandbox"), production: await field("production"), defaultEnvironment };
}

/** An env-shaped view of the resolved keys, so plaidConfig / plaidProviderFromEnv apply the same rules to both sources. */
export async function resolvedPlaidEnv(q: Q, env: NodeJS.ProcessEnv = process.env): Promise<NodeJS.ProcessEnv> {
  const c = await resolvePlaidCredentials(q, env);
  const out = {} as NodeJS.ProcessEnv;
  if (c.clientId.value) out.PLAID_CLIENT_ID = c.clientId.value;
  if (c.sandbox.value) out[plaidSecretVar("sandbox")] = c.sandbox.value;
  if (c.production.value) out[plaidSecretVar("production")] = c.production.value;
  if (c.defaultEnvironment.value) out.PLAID_ENV = c.defaultEnvironment.value;
  return out;
}

/** Plaid setup resolved at use time (env, then Settings). Never contains a key. */
export async function resolvePlaidConfig(q: Q, env: NodeJS.ProcessEnv = process.env): Promise<BankConfig> {
  return plaidConfig(await resolvedPlaidEnv(q, env));
}

/** The Plaid provider resolved at use time (per request, per scheduler tick), or null when the setup is incomplete. */
export async function resolvePlaidProvider(q: Q, env: NodeJS.ProcessEnv = process.env): Promise<BankProvider | null> {
  return plaidProviderFromEnv(await resolvedPlaidEnv(q, env));
}

export interface PlaidSecretsView {
  clientId: IdentifierFieldView;
  sandbox: SecretFieldView;
  production: SecretFieldView;
  defaultEnvironment: { value: PlaidEnvironment | null; source: SecretSource | null };
}

export async function plaidSecretsView(q: Q, env: NodeJS.ProcessEnv = process.env): Promise<PlaidSecretsView> {
  const c = await resolvePlaidCredentials(q, env);
  return { clientId: identifierView(c.clientId), sandbox: secretView(c.sandbox), production: secretView(c.production), defaultEnvironment: c.defaultEnvironment };
}

export type PlaidKeysTest = { ok: true } | { ok: false; code: string; message: string };

/** "Test keys": `/institutions/get` count 1 in `environment`. Reports Plaid's error code (INVALID_API_KEYS, …) instead of throwing. */
export async function testPlaidKeys(input: { clientId: string; secret: string; environment: PlaidEnvironment }, opts: { fetch?: typeof fetch } = {}): Promise<PlaidKeysTest> {
  try {
    await checkPlaidKeys({ clientId: input.clientId.trim(), secret: input.secret.trim(), environment: input.environment, fetch: opts.fetch });
    return { ok: true };
  } catch (e) {
    if (e instanceof PlaidApiError) return { ok: false, code: e.code ?? `HTTP_${e.status}`, message: e.message };
    return { ok: false, code: "UNREACHABLE", message: e instanceof Error ? e.message : String(e) };
  }
}

export interface PlaidSaveInput {
  clientId?: string;
  sandbox?: string;
  production?: string;
  /** null clears it; omitted keeps it. */
  defaultEnvironment?: PlaidEnvironment | null;
}

const ENV_NAME: Record<PlaidSecretField | "defaultEnvironment", string> = {
  clientId: "PLAID_CLIENT_ID",
  sandbox: plaidSecretVar("sandbox"),
  production: plaidSecretVar("production"),
  defaultEnvironment: "PLAID_ENV",
};

/** Saves the fields sent at instance level (encrypted, key file created on first need). Fields set by env are refused. */
export async function savePlaidKeys(db: Db, input: PlaidSaveInput, env: NodeJS.ProcessEnv = process.env, log: (line: string) => void = (l) => console.log(l), actor = INSTANCE_USER): Promise<void> {
  const fields = (["clientId", "sandbox", "production"] as const).filter((f) => input[f] !== undefined);
  for (const f of fields) {
    if (envValue(env, f)) throw new SecretSettingError("secret_set_by_env", `${ENV_NAME[f]} is set in the environment, which wins over Settings`, { name: ENV_NAME[f] });
  }
  if (input.defaultEnvironment !== undefined && isEnvironment(env.PLAID_ENV)) {
    throw new SecretSettingError("secret_set_by_env", "PLAID_ENV is set in the environment, which wins over Settings", { name: "PLAID_ENV" });
  }
  await db.transaction(async (tx) => {
    for (const f of fields) await writeSecretSetting(tx, INSTANCE_USER, PLAID_SETTINGS[f], input[f]!.trim(), env, log);
    if (input.defaultEnvironment !== undefined) {
      if (input.defaultEnvironment) await writeSetting(tx, INSTANCE_USER, PLAID_SETTINGS.defaultEnvironment, input.defaultEnvironment);
      else await deleteSetting(tx, INSTANCE_USER, PLAID_SETTINGS.defaultEnvironment);
    }
  });
  for (const f of fields) auditSecretChange(log, actor, PLAID_SETTINGS[f], "set");
  if (input.defaultEnvironment !== undefined) auditSecretChange(log, actor, PLAID_SETTINGS.defaultEnvironment, input.defaultEnvironment ? "set" : "removed");
}

/** Removes one saved key (env values are untouched). Returns whether something was removed. */
export async function removePlaidKey(db: Db, field: PlaidSecretField, log: (line: string) => void = (l) => console.log(l), actor = INSTANCE_USER): Promise<boolean> {
  const key = PLAID_SETTINGS[field];
  if (await readSetting(db, INSTANCE_USER, key) == null) return false;
  await removeSetting(db, INSTANCE_USER, key);
  auditSecretChange(log, actor, key, "removed");
  return true;
}
