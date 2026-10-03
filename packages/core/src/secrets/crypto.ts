import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { CodedError } from "@yomi/importers";
import { activeSecretKey } from "./keyfile";

/**
 * Secrets at rest (Plaid access and link tokens, credentials saved in Settings): AES-256-GCM with a
 * 32-byte key from the env variable YOMI_SECRET_KEY (base64 or hex), or else the key file (keyfile.ts). Stored as `enc:v1:<iv>:<ciphertext>:<tag>`, each part
 * base64; a value without the prefix is legacy plaintext and is read as is.
 */
export const SECRET_KEY_ENV = "YOMI_SECRET_KEY";
const PREFIX = "enc:v1:";
const IV_BYTES = 12;
const TAG_BYTES = 16;

export const SECRET_UNAVAILABLE_MESSAGE = "YOMI_SECRET_KEY is missing or wrong, so the bank credentials cannot be decrypted";
export const SECRET_MALFORMED_MESSAGE =
  "YOMI_SECRET_KEY is malformed: it needs a 32-byte key (base64, or 64 hex digits); generate one with pnpm secrets:gen-key";
const SECRET_CORRUPT_MESSAGE = "A stored bank credential is corrupt and cannot be decrypted";

/**
 * `missing`: an encrypted value but no key. `wrong`: GCM authentication failed (another key, or a
 * tampered value). `malformed`: the env key is not 32 bytes of base64/hex. `corrupt`: the stored
 * value has the prefix but not the format. `code` is `bank_secret_<reason>`; nothing was changed (`conflict`).
 */
export class SecretKeyError extends CodedError {
  constructor(
    reason: "missing" | "wrong" | "malformed" | "corrupt",
    message: string = reason === "malformed" ? SECRET_MALFORMED_MESSAGE : reason === "corrupt" ? SECRET_CORRUPT_MESSAGE : SECRET_UNAVAILABLE_MESSAGE,
  ) {
    super("conflict", `bank_secret_${reason}`, message);
    this.name = "SecretKeyError";
  }
}

/** 32-byte key from 64 hex chars or base64 (standard or URL-safe, padding optional). Throws `malformed`; the message never contains the value. */
export function parseSecretKey(raw: string): Buffer {
  const s = raw.trim();
  let key: Buffer | null = null;
  if (/^[0-9a-fA-F]{64}$/.test(s)) key = Buffer.from(s, "hex");
  else if (/^[A-Za-z0-9+/_-]{43}=?$/.test(s)) key = Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/"), "base64");
  if (!key || key.length !== 32) throw new SecretKeyError("malformed");
  return key;
}

const keyCache = new Map<string, Buffer>();

/** The key from YOMI_SECRET_KEY, null when unset or blank. Throws SecretKeyError(`malformed`). */
export function secretKeyFromEnv(env: NodeJS.ProcessEnv = process.env): Buffer | null {
  const raw = env[SECRET_KEY_ENV];
  if (!raw?.trim()) return null;
  let key = keyCache.get(raw);
  if (!key) {
    key = parseSecretKey(raw);
    keyCache.clear();
    keyCache.set(raw, key);
  }
  return key;
}

/** A fresh random key, base64. */
export function generateSecretKey(): string {
  return randomBytes(32).toString("base64");
}

export function isEncrypted(value: string): boolean {
  return value.startsWith(PREFIX);
}

export function encryptSecret(plain: string, key: Buffer): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ct = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  return `${PREFIX}${iv.toString("base64")}:${ct.toString("base64")}:${cipher.getAuthTag().toString("base64")}`;
}

/** Plaintext of a stored value. Legacy plaintext (no prefix) comes back unchanged and needs no key. */
export function decryptSecret(stored: string, key: Buffer | null): string {
  if (!isEncrypted(stored)) return stored;
  if (!key) throw new SecretKeyError("missing");
  const parts = stored.slice(PREFIX.length).split(":");
  if (parts.length !== 3) throw new SecretKeyError("corrupt");
  const [iv, ct, tag] = parts.map((p) => Buffer.from(p!, "base64")) as [Buffer, Buffer, Buffer];
  if (iv.length !== IV_BYTES || tag.length !== TAG_BYTES) throw new SecretKeyError("corrupt");
  try {
    const d = createDecipheriv("aes-256-gcm", key, iv);
    d.setAuthTag(tag);
    return Buffer.concat([d.update(ct), d.final()]).toString("utf8");
  } catch {
    throw new SecretKeyError("wrong");
  }
}

/** Value to store: encrypted when a key is configured (YOMI_SECRET_KEY or the key file), else the plaintext (legacy mode). Empty stays empty. */
export function sealSecret(plain: string, env: NodeJS.ProcessEnv = process.env): string {
  if (!plain) return plain;
  const key = activeSecretKey(env);
  return key ? encryptSecret(plain, key) : plain;
}

/** Plaintext of a stored value, reading the key only when the value is encrypted. */
export function openSecret(stored: string, env: NodeJS.ProcessEnv = process.env): string {
  return isEncrypted(stored) ? decryptSecret(stored, activeSecretKey(env)) : stored;
}

/** openSecret, or null when it cannot be decrypted (for display only). */
export function tryOpenSecret(stored: string, env: NodeJS.ProcessEnv = process.env): string | null {
  try {
    return openSecret(stored, env);
  } catch {
    return null;
  }
}
