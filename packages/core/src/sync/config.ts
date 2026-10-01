import { createPlaidClient, type PlaidClient, type PlaidEnvironment } from "@yomi/importers";
import { createPlaidProvider } from "./plaid";
import type { BankProvider } from "./provider";

/** What the UI needs to know about the Plaid setup. Never contains the client id or a secret. */
export interface BankConfig {
  provider: "plaid";
  /** Client id plus at least one environment secret. */
  configured: boolean;
  /** Environment new connections use unless the caller picks another available one. */
  defaultEnvironment: PlaidEnvironment;
  /** Environments that have a secret, production first. */
  environments: PlaidEnvironment[];
  /** Names of the missing env variables, in setup order. */
  missing: string[];
}

const ENVS: readonly PlaidEnvironment[] = ["production", "sandbox"];

/** Env variable holding the secret for one Plaid environment. */
export function plaidSecretVar(env: string): string {
  return `PLAID_SECRET_${env.toUpperCase()}`;
}

function parseEnv(v: string | undefined): PlaidEnvironment | null {
  const e = v?.trim().toLowerCase();
  return ENVS.includes(e as PlaidEnvironment) ? (e as PlaidEnvironment) : null;
}

/**
 * Secrets per environment: PLAID_SECRET_SANDBOX and PLAID_SECRET_PRODUCTION can both be set.
 * PLAID_SECRET is the old single-secret form: it fills the environment named by PLAID_ENV
 * (default sandbox) when that environment has no specific secret.
 */
function plaidSecrets(env: NodeJS.ProcessEnv): Partial<Record<PlaidEnvironment, string>> {
  const out: Partial<Record<PlaidEnvironment, string>> = {};
  for (const e of ENVS) {
    const s = env[plaidSecretVar(e)]?.trim();
    if (s) out[e] = s;
  }
  const legacy = env.PLAID_SECRET?.trim();
  const legacyEnv = parseEnv(env.PLAID_ENV) ?? "sandbox";
  if (legacy && !out[legacyEnv]) out[legacyEnv] = legacy;
  return out;
}

/**
 * Reads PLAID_CLIENT_ID, PLAID_SECRET_SANDBOX, PLAID_SECRET_PRODUCTION (or the legacy PLAID_SECRET)
 * and PLAID_ENV from the process env. PLAID_ENV only picks the default for new connections: when it
 * is unset or names an environment without a secret, production wins if it has a secret.
 * Secrets are only ever read here, server side.
 */
export function plaidConfig(env: NodeJS.ProcessEnv = process.env): BankConfig {
  const secrets = plaidSecrets(env);
  const environments = ENVS.filter((e) => secrets[e]);
  const wanted = parseEnv(env.PLAID_ENV);
  const defaultEnvironment = wanted && secrets[wanted] ? wanted : (environments[0] ?? wanted ?? "sandbox");
  const missing: string[] = [];
  if (!env.PLAID_CLIENT_ID?.trim()) missing.push("PLAID_CLIENT_ID");
  if (environments.length === 0) missing.push(`${plaidSecretVar("production")} / ${plaidSecretVar("sandbox")}`);
  return { provider: "plaid", configured: missing.length === 0, defaultEnvironment, environments, missing };
}

/** The Plaid provider built from env (one client per environment with a secret), or null when the setup is incomplete. */
export function plaidProviderFromEnv(env: NodeJS.ProcessEnv = process.env): BankProvider | null {
  const cfg = plaidConfig(env);
  if (!cfg.configured) return null;
  const secrets = plaidSecrets(env);
  const clientId = env.PLAID_CLIENT_ID!.trim();
  const clients: Partial<Record<PlaidEnvironment, PlaidClient>> = {};
  for (const e of cfg.environments) clients[e] = createPlaidClient({ clientId, secret: secrets[e]!, environment: e });
  return createPlaidProvider(clients, { defaultEnvironment: cfg.defaultEnvironment });
}
