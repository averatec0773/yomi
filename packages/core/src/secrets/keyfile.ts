import { chmodSync, closeSync, fsyncSync, mkdirSync, openSync, readFileSync, statSync, writeSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { generateSecretKey, parseSecretKey, SecretKeyError, secretKeyFromEnv } from "./crypto";

/**
 * The master key when YOMI_SECRET_KEY is not set: a key file created on first need (saving a secret in
 * Settings) and loaded on start. Default `~/.config/yomi/secret.key` (`$XDG_CONFIG_HOME/yomi/secret.key`),
 * outside the repository and the data directory, so the ledger file, its backups and a copy of data/ never
 * carry the key that opens them. YOMI_SECRET_KEY_FILE overrides the path. The key is never written to the
 * database or to a log; only the path is logged.
 */
export const SECRET_KEY_FILE_ENV = "YOMI_SECRET_KEY_FILE";

export function defaultKeyFilePath(env: NodeJS.ProcessEnv = process.env): string {
  const explicit = env[SECRET_KEY_FILE_ENV]?.trim();
  if (explicit) return path.resolve(explicit);
  const config = env.XDG_CONFIG_HOME?.trim() || path.join(os.homedir(), ".config");
  return path.join(config, "yomi", "secret.key");
}

interface KeyFileState {
  /** Path set by configureKeyFile; null until the host opts in (tests never do unless they mean to). */
  path: string | null;
  key: Buffer | null;
}

// Shared across the module copies Next.js bundles (instrumentation, route handlers, server components).
const g = globalThis as unknown as { yomiKeyFile?: KeyFileState };
function state(): KeyFileState {
  g.yomiKeyFile ??= { path: null, key: null };
  return g.yomiKeyFile;
}

/** Reads a key file: null when it does not exist. Throws SecretKeyError(`malformed`) for bad content. Tightens loose permissions to 0600. */
export function readKeyFile(file: string): Buffer | null {
  let raw: string;
  try {
    raw = readFileSync(file, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw e;
  }
  if (process.platform !== "win32" && (statSync(file).mode & 0o077) !== 0) chmodSync(file, 0o600);
  return parseSecretKey(raw);
}

/**
 * Creates the key file with a fresh key (directory 0700, file 0600, exclusive create so two processes
 * cannot both write one) and returns the key. When the file appeared meanwhile, the existing key is returned.
 */
export function createKeyFile(file: string): Buffer {
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  let fd: number;
  try {
    fd = openSync(file, "wx", 0o600);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "EEXIST") return readKeyFile(file)!;
    throw e;
  }
  const encoded = generateSecretKey();
  try {
    writeSync(fd, `${encoded}\n`);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  return parseSecretKey(encoded);
}

/**
 * Opts this process into the key file at `file` (web server and CLIs call it on start) and loads it when it
 * exists. `null` switches the key file off (tests). Never throws for a missing file; a malformed file is
 * reported by secretKeyInfo.
 */
export function configureKeyFile(file: string | null): void {
  const s = state();
  s.path = file;
  s.key = null;
  if (!file) return;
  try {
    s.key = readKeyFile(file);
  } catch {
    s.key = null;
  }
}

/** The key file path in use, or null when the process has not opted in. */
export function configuredKeyFile(): string | null {
  return state().path;
}

function fileKey(): Buffer | null {
  const s = state();
  if (!s.path) return null;
  if (!s.key) {
    try {
      s.key = readKeyFile(s.path);
    } catch {
      return null;
    }
  }
  return s.key;
}

/**
 * The key that seals and opens secrets: YOMI_SECRET_KEY when set (a malformed value throws, never falls back),
 * else the configured key file's key, else null.
 */
export function activeSecretKey(env: NodeJS.ProcessEnv = process.env): Buffer | null {
  return secretKeyFromEnv(env) ?? fileKey();
}

export interface SecretKeyInfo {
  source: "env" | "file" | "none";
  /** `malformed`: YOMI_SECRET_KEY (or the key file) is not 32 bytes of base64/hex. */
  state: "present" | "missing" | "malformed";
  /** The key file path when the file is (or would be) used; null when YOMI_SECRET_KEY is set. */
  file: string | null;
}

export function secretKeyInfo(env: NodeJS.ProcessEnv = process.env): SecretKeyInfo {
  try {
    if (secretKeyFromEnv(env)) return { source: "env", state: "present", file: null };
  } catch {
    return { source: "env", state: "malformed", file: null };
  }
  const file = configuredKeyFile();
  if (!file) return { source: "none", state: "missing", file: null };
  try {
    return readKeyFile(file) ? { source: "file", state: "present", file } : { source: "none", state: "missing", file };
  } catch {
    return { source: "file", state: "malformed", file };
  }
}

/**
 * The key for sealing a new secret, creating the key file on first need. Throws SecretKeyError(`malformed`)
 * when YOMI_SECRET_KEY or the key file is malformed, and (`missing`) when no key file is configured.
 */
export function ensureSecretKey(env: NodeJS.ProcessEnv = process.env, log: (line: string) => void = (l) => console.log(l)): Buffer {
  const fromEnv = secretKeyFromEnv(env);
  if (fromEnv) return fromEnv;
  const s = state();
  if (!s.path) throw new SecretKeyError("missing");
  const existing = readKeyFile(s.path);
  if (existing) {
    s.key = existing;
    return existing;
  }
  s.key = createKeyFile(s.path);
  log(`[yomi] Created the secret key file ${s.path} (back it up; without it saved secrets cannot be read)`);
  return s.key;
}
