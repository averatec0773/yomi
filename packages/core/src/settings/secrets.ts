import { CodedError } from "@yomi/importers";
import { decryptSecret, encryptSecret, isEncrypted } from "../secrets/crypto";
import { activeSecretKey, ensureSecretKey } from "../secrets/keyfile";
import type { CurrentUser } from "../user";
import { deleteSetting, type Q, readSetting, writeSetting } from "./store";

/**
 * Instance-wide settings (Plaid developer keys) live in user_settings under the reserved user id 0: no real
 * user has it (users start at 1), so they never mix with anyone's own settings and need no extra table.
 */
export const INSTANCE_USER: CurrentUser = Object.freeze({ id: 0 });

/** Where a credential comes from. Env always wins over Settings. */
export type SecretSource = "env" | "settings";

/** What the API and UI may know about one stored or env credential: never the value. */
export interface SecretFieldView {
  configured: boolean;
  /** Last 4 characters, only when the value is at least 8 long (shorter values show nothing). */
  last4: string | null;
  source: SecretSource | null;
  /** Stored in Settings but the current key cannot open it (key file lost or replaced). */
  unreadable: boolean;
}

export const NO_SECRET: SecretFieldView = Object.freeze({ configured: false, last4: null, source: null, unreadable: false });

export function last4(value: string): string | null {
  return value.length >= 8 ? value.slice(-4) : null;
}

/** A stored credential: plaintext, or `unreadable` when it cannot be decrypted. */
export type StoredSecret = { value: string } | { unreadable: true } | null;

/** Reads and decrypts one secret setting. Values are always stored sealed (`enc:v1:`). */
export async function readSecretSetting(q: Q, user: CurrentUser, key: string, env: NodeJS.ProcessEnv = process.env): Promise<StoredSecret> {
  const stored = await readSetting(q, user, key);
  if (!stored) return null;
  if (!isEncrypted(stored)) return { unreadable: true };
  try {
    return { value: decryptSecret(stored, activeSecretKey(env)) };
  } catch {
    return { unreadable: true };
  }
}

/** Encrypts and stores one secret setting, creating the key file on first need. Never stores plaintext. */
export async function writeSecretSetting(q: Q, user: CurrentUser, key: string, plain: string, env: NodeJS.ProcessEnv = process.env, log?: (line: string) => void): Promise<void> {
  const master = ensureSecretKey(env, log);
  await writeSetting(q, user, key, encryptSecret(plain, master));
}

export { deleteSetting as removeSetting };

/** The value one field resolves to: env first, then Settings. */
export interface ResolvedSecret {
  value: string | null;
  source: SecretSource | null;
  unreadable: boolean;
}

export function resolveSecret(envValue: string | undefined, stored: StoredSecret): ResolvedSecret {
  const fromEnv = envValue?.trim();
  if (fromEnv) return { value: fromEnv, source: "env", unreadable: false };
  if (stored && "value" in stored) return { value: stored.value, source: "settings", unreadable: false };
  return { value: null, source: stored ? "settings" : null, unreadable: stored != null };
}

export function secretView(r: ResolvedSecret): SecretFieldView {
  return { configured: r.value != null, last4: r.value ? last4(r.value) : null, source: r.source, unreadable: r.unreadable };
}

/**
 * An identifier (Flex query ID, Plaid client ID): stored sealed like a secret, but not secret, so the value saved in
 * Settings is shown and edited in clear. A value from env stays on the server (the UI shows "Set by environment").
 */
export interface IdentifierFieldView extends SecretFieldView {
  value: string | null;
}

export function identifierView(r: ResolvedSecret): IdentifierFieldView {
  return { ...secretView(r), value: r.source === "settings" ? r.value : null };
}

/** A save or remove that is not allowed (a field set by env, an invalid value). `code` is stable for the UI. */
export class SecretSettingError extends CodedError {
  constructor(code: "secret_set_by_env" | "secret_invalid", message: string, params: Record<string, string> = {}) {
    super(code, message, params);
    this.name = "SecretSettingError";
  }
}

/**
 * One audit line per change: which setting, what happened, which user, when. Never the value.
 * e.g. `[yomi] audit: user 1 set ibkr_flex_token at 2026-09-30T12:00:00.000Z`.
 */
export function auditSecretChange(log: (line: string) => void, user: CurrentUser, setting: string, action: "set" | "removed", now: Date = new Date()): void {
  log(`[yomi] audit: user ${user.id} ${action} ${setting} at ${now.toISOString()}`);
}
