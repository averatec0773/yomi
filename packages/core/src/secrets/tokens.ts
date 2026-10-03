import { type BackupOptions, backupDatabase, bankConnections, compactTables, type Db, listTables, plaidLinkSessions } from "@yomi/db";
import { and, eq } from "@yomi/db/orm";
import { decryptSecret, encryptSecret, isEncrypted, SecretKeyError } from "./crypto";
import { activeSecretKey, secretKeyInfo } from "./keyfile";

/** Columns holding Plaid secrets: bank_connections.access_token and plaid_link_sessions.link_token. */
export type TokenTable = "bank_connections" | "plaid_link_sessions";
export const TOKEN_TABLES: readonly TokenTable[] = ["bank_connections", "plaid_link_sessions"];

export interface StoredToken {
  table: TokenTable;
  id: number;
  value: string;
}

/** Every non-empty stored token (a disconnected connection keeps ""), from the tables present in `db`. */
export async function readStoredTokens(db: Db, tables: readonly TokenTable[] = TOKEN_TABLES): Promise<StoredToken[]> {
  const out: StoredToken[] = [];
  if (tables.includes("bank_connections")) {
    for (const r of (await db.select({ id: bankConnections.id, value: bankConnections.accessToken }).from(bankConnections))) {
      if (r.value) out.push({ table: "bank_connections", ...r });
    }
  }
  if (tables.includes("plaid_link_sessions")) {
    for (const r of (await db.select({ id: plaidLinkSessions.id, value: plaidLinkSessions.linkToken }).from(plaidLinkSessions))) {
      if (r.value) out.push({ table: "plaid_link_sessions", ...r });
    }
  }
  return out;
}

/** Replaces one token only if it still holds `from`; returns the number of rows changed (0 or 1). */
async function replaceToken(tx: Db, t: StoredToken, to: string): Promise<number> {
  if (t.table === "bank_connections") {
    return (
      await tx
        .update(bankConnections)
        .set({ accessToken: to })
        .where(and(eq(bankConnections.id, t.id), eq(bankConnections.accessToken, t.value)))
        .returning({ id: bankConnections.id })
    ).length;
  }
  return (
    await tx
      .update(plaidLinkSessions)
      .set({ linkToken: to })
      .where(and(eq(plaidLinkSessions.id, t.id), eq(plaidLinkSessions.linkToken, t.value)))
      .returning({ id: plaidLinkSessions.id })
  ).length;
}

async function currentValue(tx: Db, t: StoredToken): Promise<string | undefined> {
  if (t.table === "bank_connections") {
    return (await tx.select({ v: bankConnections.accessToken }).from(bankConnections).where(eq(bankConnections.id, t.id)).limit(1))[0]?.v;
  }
  return (await tx.select({ v: plaidLinkSessions.linkToken }).from(plaidLinkSessions).where(eq(plaidLinkSessions.id, t.id)).limit(1))[0]?.v;
}

/**
 * Encrypts the plaintext tokens among `tokens` inside one transaction: each ciphertext is decrypted
 * and compared before it is written, and after all writes every row is read back and decrypted
 * against the in-memory original. Any mismatch throws and rolls everything back.
 * Returns how many were encrypted.
 */
export async function encryptTokensInTransaction(db: Db, tokens: readonly StoredToken[], key: Buffer): Promise<number> {
  const plain = tokens.filter((t) => !isEncrypted(t.value));
  if (plain.length === 0) return 0;
  await db.transaction(async (tx) => {
    for (const t of plain) {
      const enc = encryptSecret(t.value, key);
      if (decryptSecret(enc, key) !== t.value) throw new Error(`Encryption check failed (${t.table} #${t.id}), nothing written`);
      if (await replaceToken(tx, t, enc) !== 1) throw new Error(`${t.table} #${t.id} changed during encryption, nothing written`);
    }
    for (const t of plain) {
      const stored = await currentValue(tx, t);
      if (stored == null || !isEncrypted(stored) || decryptSecret(stored, key) !== t.value) {
        throw new Error(`Read-back check after encryption failed (${t.table} #${t.id}), nothing written`);
      }
    }
  });
  return plain.length;
}

export interface SecretsHealth {
  /** The master key (YOMI_SECRET_KEY, else the key file): set and valid, unset, or set but not 32 bytes of base64/hex. */
  key: "present" | "missing" | "malformed";
  /** Where the key comes from. */
  keySource: "env" | "file" | "none";
  plaintext: number;
  encrypted: number;
  /** Encrypted tokens the current key cannot open (no key, wrong key, tampered). */
  undecryptable: number;
  /** Encrypted tokens exist that cannot be opened: bank operations must stop and write nothing. */
  locked: boolean;
  /** What the bank section shows: the blocking error (English), else null. */
  error: string | null;
  /** Stable code of `error` (`bank_secret_malformed` / `_missing` / `_wrong`), for the UI to translate. */
  errorCode: string | null;
}

export async function secretsHealth(db: Db, env: NodeJS.ProcessEnv = process.env): Promise<SecretsHealth> {
  let key: Buffer | null = null;
  let keyState: SecretsHealth["key"] = "missing";
  const info = secretKeyInfo(env);
  try {
    key = activeSecretKey(env);
    if (key) keyState = "present";
    else if (info.state === "malformed") keyState = "malformed";
  } catch {
    keyState = "malformed";
  }
  let plaintext = 0;
  let encrypted = 0;
  let undecryptable = 0;
  for (const t of (await readStoredTokens(db))) {
    if (!isEncrypted(t.value)) {
      plaintext += 1;
      continue;
    }
    encrypted += 1;
    try {
      decryptSecret(t.value, key);
    } catch {
      undecryptable += 1;
    }
  }
  const locked = undecryptable > 0;
  const failure = keyState === "malformed" ? new SecretKeyError("malformed") : locked ? new SecretKeyError(keyState === "missing" ? "missing" : "wrong") : null;
  return { key: keyState, keySource: key ? info.source : "none", plaintext, encrypted, undecryptable, locked, error: failure?.message ?? null, errorCode: failure?.code ?? null };
}

/**
 * Throws before any bank operation that stores or uses a token when the key is malformed or stored
 * tokens cannot be decrypted, so nothing is exchanged at Plaid that could not be stored and nothing
 * is written next to tokens a missing key cannot read.
 */
export async function assertSecretsUsable(db: Db, env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const h = await secretsHealth(db, env);
  if (h.key === "malformed") throw new SecretKeyError("malformed");
  if (h.locked) throw new SecretKeyError(h.key === "missing" ? "missing" : "wrong");
}

export interface EncryptStoredResult {
  encrypted: number;
  backupPath: string | null;
}

/**
 * Startup upgrade: with a key configured, encrypts every plaintext token in place (one transaction,
 * verified, see encryptTokensInTransaction) after a `pre-encrypt` backup. Idempotent: nothing to do
 * means no backup and no write. Without a key it does nothing. Throws SecretKeyError without writing
 * when the key is malformed or cannot open tokens already encrypted (a different key).
 */
export async function encryptStoredTokens(db: Db, opts: { env?: NodeJS.ProcessEnv; backup?: BackupOptions | false } = {}): Promise<EncryptStoredResult> {
  const key = activeSecretKey(opts.env ?? process.env);
  if (!key) return { encrypted: 0, backupPath: null };
  const present = new Set((await listTables(db)));
  const tokens = await readStoredTokens(
    db,
    TOKEN_TABLES.filter((t) => present.has(t)),
  );
  for (const t of tokens) if (isEncrypted(t.value)) decryptSecret(t.value, key);
  if (!tokens.some((t) => !isEncrypted(t.value))) return { encrypted: 0, backupPath: null };
  const backupPath = opts.backup === false ? null : await backupDatabase(db, "pre-encrypt", opts.backup ?? {});
  const encrypted = await encryptTokensInTransaction(db, tokens, key);
  // Postgres keeps the replaced row versions (with the plaintext) until vacuum, and the WAL keeps the writes:
  // rewrite the token tables and drop the old WAL now.
  await compactTables(db, TOKEN_TABLES.filter((t) => present.has(t)));
  return { encrypted, backupPath };
}

/** encryptStoredTokens for the web server and CLIs: never throws, logs one line (never a token). */
export async function upgradeSecretsOnOpen(db: Db, opts: { env?: NodeJS.ProcessEnv; log?: (line: string) => void; backup?: BackupOptions | false } = {}): Promise<EncryptStoredResult | null> {
  const log = opts.log ?? ((l: string) => console.log(l));
  try {
    const r = await encryptStoredTokens(db, opts);
    if (r.encrypted > 0) log(`[yomi] Encrypted ${r.encrypted} bank credential(s)`);
    return r;
  } catch (e) {
    log(`[yomi] ${e instanceof SecretKeyError ? e.message : `Encrypting bank credentials failed, nothing changed: ${e instanceof Error ? e.message : String(e)}`}`);
    return null;
  }
}
