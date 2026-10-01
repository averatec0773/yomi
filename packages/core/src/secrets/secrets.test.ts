import { createHash, randomBytes } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { gunzipSync } from "node:zlib";
import { bankConnections, closeDb, createDb, type Db, jobs, listTables, migrate, openBackupFile, pgliteOf, plaidLinkSessions, queryRows } from "@yomi/db";
import { isolatedTestDb, migratedTestDir } from "@yomi/db/testing";
import type { NormalizedRow } from "@yomi/importers";
import { asc, eq, sql } from "@yomi/db/orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { freshDb, user } from "../ledger/test-helpers";
import { seed } from "../seed";
import { runBankSyncJob } from "../sync/job";
import { recoverLinkSessions } from "../sync/link-sessions";
import type { BankProvider, ProviderLinkSession } from "../sync/provider";
import { connectWithPublicToken, createLinkToken, disconnectConnection, listConnections, syncAll, syncConnection } from "../sync/sync";
import {
  decryptSecret,
  encryptSecret,
  isEncrypted,
  openSecret,
  parseSecretKey,
  SECRET_UNAVAILABLE_MESSAGE,
  SecretKeyError,
  secretKeyFromEnv,
} from "./crypto";
import { scrubBackupFile } from "./scrub";
import { encryptStoredTokens, secretsHealth, upgradeSecretsOnOpen } from "./tokens";

const KEY_B64 = randomBytes(32).toString("base64");
const OTHER_B64 = randomBytes(32).toString("base64");
const key = () => parseSecretKey(KEY_B64);
const ACCESS = "access-production-00000000-aaaa-bbbb-cccc-000000000001";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("encryptSecret / decryptSecret", () => {
  it("round-trips and uses a fresh IV each time", () => {
    const a = encryptSecret(ACCESS, key());
    const b = encryptSecret(ACCESS, key());
    expect(a).toMatch(/^enc:v1:[A-Za-z0-9+/=]+:[A-Za-z0-9+/=]+:[A-Za-z0-9+/=]+$/);
    expect(a).not.toBe(b);
    expect(a).not.toContain(ACCESS);
    expect(decryptSecret(a, key())).toBe(ACCESS);
    expect(decryptSecret(b, key())).toBe(ACCESS);
  });

  it("detects tampering with ciphertext, IV or tag", () => {
    const enc = encryptSecret(ACCESS, key());
    const [, , iv, ct, tag] = enc.split(":") as [string, string, string, string, string];
    const flip = (b64: string) => {
      const buf = Buffer.from(b64, "base64");
      buf[0]! ^= 1;
      return buf.toString("base64");
    };
    for (const bad of [`enc:v1:${iv}:${flip(ct)}:${tag}`, `enc:v1:${flip(iv)}:${ct}:${tag}`, `enc:v1:${iv}:${ct}:${flip(tag)}`]) {
      expect(() => decryptSecret(bad, key())).toThrow(expect.objectContaining({ kind: "wrong" }));
    }
    expect(() => decryptSecret("enc:v1:abc", key())).toThrow(expect.objectContaining({ kind: "corrupt" }));
  });

  it("a wrong key fails GCM authentication; a missing key is its own error", () => {
    const enc = encryptSecret(ACCESS, key());
    expect(() => decryptSecret(enc, parseSecretKey(OTHER_B64))).toThrow(SecretKeyError);
    expect(() => decryptSecret(enc, parseSecretKey(OTHER_B64))).toThrow(SECRET_UNAVAILABLE_MESSAGE);
    expect(() => decryptSecret(enc, null)).toThrow(expect.objectContaining({ kind: "missing" }));
  });

  it("reads legacy plaintext unchanged, with or without a key", () => {
    expect(isEncrypted(ACCESS)).toBe(false);
    expect(decryptSecret(ACCESS, null)).toBe(ACCESS);
    expect(decryptSecret(ACCESS, key())).toBe(ACCESS);
    expect(openSecret(ACCESS, { YOMI_SECRET_KEY: "not a key" })).toBe(ACCESS);
  });

  it("accepts base64 (padded or not, URL-safe) and hex keys, and rejects anything else without echoing it", () => {
    const raw = randomBytes(32);
    for (const s of [raw.toString("base64"), raw.toString("base64").replace(/=$/, ""), raw.toString("base64url"), raw.toString("hex"), ` ${raw.toString("hex")}\n`]) {
      expect(parseSecretKey(s).equals(raw)).toBe(true);
    }
    expect(secretKeyFromEnv({})).toBeNull();
    expect(secretKeyFromEnv({ YOMI_SECRET_KEY: "  " })).toBeNull();
    for (const bad of ["short", randomBytes(16).toString("base64"), randomBytes(31).toString("hex"), `${raw.toString("hex")}zz`]) {
      let err: unknown;
      try {
        secretKeyFromEnv({ YOMI_SECRET_KEY: bad });
      } catch (e) {
        err = e;
      }
      expect(err).toBeInstanceOf(SecretKeyError);
      expect((err as SecretKeyError).kind).toBe("malformed");
      expect((err as Error).message).not.toContain(bad);
      expect((err as Error).message).toContain("YOMI_SECRET_KEY");
    }
  });
});

function row(id: string, amountMinor: number): NormalizedRow {
  return {
    source: "plaid",
    lineNo: 1,
    externalId: id,
    occurredAt: "2026-09-10T12:00:00-05:00",
    amountMinor,
    currency: "USD",
    originalAmountMinor: null,
    originalCurrency: null,
    direction: "out",
    kind: "expense",
    status: "ok",
    counterparty: "SHOP",
    description: "SHOP",
    sourceCategory: null,
    paymentMethod: null,
    raw: {},
  };
}

/** Fake Plaid behind the BankProvider seam; records every token it is handed. */
function fakeProvider() {
  const seen: { op: string; token: string }[] = [];
  const sessions = new Map<string, ProviderLinkSession[]>();
  let links = 0;
  const p: BankProvider & { seen: typeof seen; sessions: typeof sessions } = {
    id: "plaid",
    source: "plaid",
    environments: ["production"],
    defaultEnvironment: "production",
    seen,
    sessions,
    tokenEnvironment: (t) => /^access-(\w+)-/.exec(t)?.[1] ?? null,
    createLinkToken: async (o) => {
      if (o.accessToken) seen.push({ op: "linkUpdate", token: o.accessToken });
      links += 1;
      return { linkToken: `link-production-${links}`, expiration: "2026-09-29T04:00:00Z" };
    },
    getLinkSessions: async (linkToken) => {
      seen.push({ op: "linkGet", token: linkToken });
      return sessions.get(linkToken) ?? [];
    },
    exchangePublicToken: async (pt) => ({ accessToken: pt === "public-2" ? `${ACCESS}-2` : ACCESS, enrollmentId: pt === "public-2" ? "item_2" : "item_1" }),
    listAccounts: async (c) => {
      seen.push({ op: "accounts", token: c.accessToken });
      return [
        {
          providerAccountId: "acc_1",
          institutionName: "Bank of America",
          name: "Card",
          type: "credit",
          subtype: "credit card",
          lastFour: "4321",
          currency: "USD",
          ledgerKind: "credit_card",
        },
      ];
    },
    fetchChanges: async (c, cursor) => {
      seen.push({ op: "sync", token: c.accessToken });
      return {
        added: cursor ? [] : [{ providerAccountId: "acc_1", row: row("t1", -1250) }],
        modified: [],
        removed: [],
        accounts: null,
        nextCursor: "c1",
      };
    },
    disconnect: async (c) => {
      seen.push({ op: "remove", token: c.accessToken });
    },
  };
  return p;
}

const tokensIn = async (db: Db) => ({
  conns: await db.select().from(bankConnections).orderBy(asc(bankConnections.id)),
  sessions: await db.select().from(plaidLinkSessions).orderBy(asc(plaidLinkSessions.id)),
  jobs: await db.select().from(jobs),
});

describe("tokens with YOMI_SECRET_KEY set", () => {
  beforeEach(() => {
    vi.stubEnv("YOMI_SECRET_KEY", KEY_B64);
  });

  it("stores access and link tokens encrypted, and hands Plaid the plaintext for sync, update mode, recovery and disconnect", async () => {
    const db = await freshDb();
    const p = fakeProvider();
    const lt = await createLinkToken(db, user, p);
    const conn = await connectWithPublicToken(db, user, p, { publicToken: "public-1", institutionName: "Bank of America", linkSessionId: lt.sessionId });
    const stored = (await db.select().from(bankConnections).orderBy(asc(bankConnections.id)).limit(1))[0]!;
    expect(isEncrypted(stored.accessToken)).toBe(true);
    expect(stored.accessToken).not.toContain("access-");
    expect(openSecret(stored.accessToken)).toBe(ACCESS);
    const sess = (await db.select().from(plaidLinkSessions).orderBy(asc(plaidLinkSessions.id)).limit(1))[0]!;
    expect(isEncrypted(sess.linkToken)).toBe(true);
    expect(openSecret(sess.linkToken)).toBe(lt.linkToken);
    expect(conn.environment).toBe("production");
    expect((await listConnections(db, user))[0]!.environment).toBe("production");

    const r = await syncConnection(db, user, p, conn.id, { backup: false });
    expect(r.inserted).toBe(1);
    expect((await syncAll(db, user, p, { backup: false })).errors).toEqual([]);

    await createLinkToken(db, user, p, { connectionId: conn.id });

    // Recovery: a second login made in a Link session the browser never reported.
    const lt2 = await createLinkToken(db, user, p);
    p.sessions.set(lt2.linkToken, [
      { linkSessionId: "s2", finished: true, exitStatus: "connected", items: [{ publicToken: "public-2", institutionName: "Bank of America" }] },
    ]);
    const rec = await recoverLinkSessions(db, user, p, { firstDataRetryMs: [] });
    expect(rec.recovered).toHaveLength(1);
    const second = (await db.select().from(bankConnections).where(eq(bankConnections.enrollmentId, "item_2")).limit(1))[0]!;
    expect(openSecret(second.accessToken)).toBe(`${ACCESS}-2`);

    await disconnectConnection(db, user, p, conn.id);
    expect((await db.select().from(bankConnections).where(eq(bankConnections.id, conn.id)).limit(1))[0]!.accessToken).toBe("");

    for (const s of p.seen) expect(s.token.startsWith("enc:")).toBe(false);
    expect(p.seen.map((s) => s.op)).toEqual(expect.arrayContaining(["sync", "linkUpdate", "linkGet", "remove", "accounts"]));
    expect(p.seen.filter((s) => s.op === "remove")).toEqual([{ op: "remove", token: ACCESS }]);
    expect(p.seen.filter((s) => s.op === "linkGet").map((s) => s.token)).toContain(lt2.linkToken);
  });
});

/** A ledger with one plaintext connection and one plaintext link session, as before this change. */
async function legacyDb(given?: Db): Promise<Db> {
  const db = given ?? (await freshDb());
  const id = (await db
    .insert(bankConnections)
    .values({ userId: user.id, provider: "plaid", enrollmentId: "item_1", institutionName: "Bank of America", accessToken: ACCESS, status: "active" })
    .returning())[0]!.id;
  await db.insert(bankConnections)
    .values({ userId: user.id, provider: "plaid", enrollmentId: "item_gone", institutionName: "Old", accessToken: "", status: "disconnected" });
  await db.insert(plaidLinkSessions)
    .values({ userId: user.id, linkToken: "link-production-legacy", environment: "production", purpose: "new", connectionId: id, status: "completed" });
  return db;
}

describe("startup upgrade", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "yomi-secrets-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  async function fileDb(): Promise<Db> {
    await migratedTestDir(path.join(dir, "yomi"));
    const db = await createDb(path.join(dir, "yomi"));
    await migrate(db, undefined, { dir: path.join(dir, "backups") });
    await seed(db);
    return await legacyDb(db);
  }

  it("encrypts plaintext tokens after a pre-encrypt backup, verifies them, and is idempotent", async () => {
    const db = await fileDb();
    const lines: string[] = [];
    const env = { YOMI_SECRET_KEY: KEY_B64 };
    let r;
    try {
      r = await upgradeSecretsOnOpen(db, { env, log: (l) => lines.push(l), backup: { dir: path.join(dir, "backups") } });
    } catch (e) {
      await closeDb(db);
      throw e;
    }
    expect(r).toMatchObject({ encrypted: 2 });
    expect(r!.backupPath).toMatch(/yomi-\d{8}-\d{6}-pre-encrypt\.tar\.gz$/);
    expect(lines).toEqual(["[yomi] Encrypted 2 bank credential(s)"]);
    const conn = (await db.select().from(bankConnections).where(eq(bankConnections.enrollmentId, "item_1")).limit(1))[0]!;
    expect(conn.accessToken.startsWith("enc:v1:")).toBe(true);
    expect(decryptSecret(conn.accessToken, key())).toBe(ACCESS);
    expect((await db.select().from(bankConnections).where(eq(bankConnections.enrollmentId, "item_gone")).limit(1))[0]!.accessToken).toBe("");
    expect(decryptSecret((await db.select().from(plaidLinkSessions).orderBy(asc(plaidLinkSessions.id)).limit(1))[0]!.linkToken, key())).toBe("link-production-legacy");
    expect(await secretsHealth(db, env)).toMatchObject({ plaintext: 0, encrypted: 2, locked: false, error: null });
    // The data directory no longer holds the plaintext in any file (VACUUM FULL + CHECKPOINT).
    await closeDb(db);
    expect(filesHolding(path.join(dir, "yomi"), ACCESS)).toEqual([]);

    const again = await createDb(path.join(dir, "yomi"));
    try {
      const lines2: string[] = [];
      expect(await upgradeSecretsOnOpen(again, { env, log: (l) => lines2.push(l), backup: { dir: path.join(dir, "backups") } })).toEqual({ encrypted: 0, backupPath: null });
      expect(lines2).toEqual([]);
      expect(readdirSync(path.join(dir, "backups")).filter((f) => f.includes("pre-encrypt"))).toHaveLength(1);
      expect(decryptSecret((await again.select().from(bankConnections).where(eq(bankConnections.enrollmentId, "item_1")).limit(1))[0]!.accessToken, key())).toBe(ACCESS);
    } finally {
      await closeDb(again);
    }
  });

  it("does nothing without a key", async () => {
    const db = await legacyDb();
    expect(await encryptStoredTokens(db, { env: {} })).toEqual({ encrypted: 0, backupPath: null });
    expect((await db.select().from(bankConnections).orderBy(asc(bankConnections.id)).limit(1))[0]!.accessToken).toBe(ACCESS);
    expect(await secretsHealth(db, {})).toMatchObject({ key: "missing", plaintext: 2, encrypted: 0, locked: false, error: null });
  });

  it("refuses to write with a key that cannot open tokens already encrypted, or a malformed key", async () => {
    const db = await legacyDb();
    await encryptStoredTokens(db, { env: { YOMI_SECRET_KEY: KEY_B64 }, backup: false });
    await db.insert(plaidLinkSessions).values({ userId: user.id, linkToken: "link-production-new", environment: "production", purpose: "new" });
    const before = await tokensIn(db);
    const lines: string[] = [];
    expect(await upgradeSecretsOnOpen(db, { env: { YOMI_SECRET_KEY: OTHER_B64 }, log: (l) => lines.push(l), backup: false })).toBeNull();
    expect(await upgradeSecretsOnOpen(db, { env: { YOMI_SECRET_KEY: "garbage" }, log: (l) => lines.push(l), backup: false })).toBeNull();
    expect(await tokensIn(db)).toEqual(before);
    expect(lines).toEqual([`[yomi] ${SECRET_UNAVAILABLE_MESSAGE}`, expect.stringContaining("YOMI_SECRET_KEY is malformed")]);
  });
});

describe("encrypted tokens but a missing or wrong key", () => {
  async function encryptedLedger() {
    vi.stubEnv("YOMI_SECRET_KEY", KEY_B64);
    const db = await freshDb();
    const p = fakeProvider();
    const lt = await createLinkToken(db, user, p);
    const conn = await connectWithPublicToken(db, user, p, { publicToken: "public-1", institutionName: "Bank of America", linkSessionId: lt.sessionId });
    await createLinkToken(db, user, p); // an open session for recovery to find
    p.seen.length = 0;
    return { db, p, conn };
  }

  for (const [label, value] of [
    ["missing", ""],
    ["wrong", OTHER_B64],
  ] as const) {
    it(`${label} key: every bank operation fails with the key error and nothing is written`, async () => {
      const { db, p, conn } = await encryptedLedger();
      vi.stubEnv("YOMI_SECRET_KEY", value);
      const before = await tokensIn(db);
      const h = await secretsHealth(db);
      expect(h).toMatchObject({ locked: true, error: SECRET_UNAVAILABLE_MESSAGE, key: label === "missing" ? "missing" : "present" });

      const attempts: Promise<unknown>[] = [
        syncConnection(db, user, p, conn.id, { backup: false }),
        recoverLinkSessions(db, user, p),
        createLinkToken(db, user, p, { connectionId: conn.id }),
        createLinkToken(db, user, p),
        connectWithPublicToken(db, user, p, { publicToken: "public-2", institutionName: null }),
        disconnectConnection(db, user, p, conn.id),
      ];
      for (const a of attempts) await expect(a).rejects.toThrow(SECRET_UNAVAILABLE_MESSAGE);

      const job = await runBankSyncJob(db, user, p, { backup: false });
      expect(job).toMatchObject({ ran: false, reason: "secrets_unavailable", message: SECRET_UNAVAILABLE_MESSAGE });
      expect((await listConnections(db, user))[0]).toMatchObject({ status: "active", lastError: null, environment: null });

      expect(await tokensIn(db)).toEqual(before);
      expect(p.seen).toEqual([]);
      await upgradeSecretsOnOpen(db, { log: () => {}, backup: false });
      expect(await tokensIn(db)).toEqual(before);

      // Fixing the key resumes as if nothing happened.
      vi.stubEnv("YOMI_SECRET_KEY", KEY_B64);
      expect((await syncConnection(db, user, p, conn.id, { backup: false })).inserted).toBe(1);
    });
  }

  it("without a key and only plaintext tokens everything works as before (plaintext stays plaintext)", async () => {
    vi.stubEnv("YOMI_SECRET_KEY", "");
    const db = await legacyDb();
    const p = fakeProvider();
    const id = (await db.select().from(bankConnections).orderBy(asc(bankConnections.id)).limit(1))[0]!.id;
    expect((await syncConnection(db, user, p, id, { backup: false })).inserted).toBe(1);
    const lt = await createLinkToken(db, user, p);
    expect((await db.select().from(plaidLinkSessions).where(eq(plaidLinkSessions.id, lt.sessionId)).limit(1))[0]!.linkToken).toBe(lt.linkToken);
    expect((await db.select().from(bankConnections).orderBy(asc(bankConnections.id)).limit(1))[0]!.accessToken).toBe(ACCESS);
    expect(await secretsHealth(db)).toMatchObject({ key: "missing", locked: false, error: null });
    expect((await secretsHealth(db)).plaintext).toBeGreaterThan(0);
  });

  it("a malformed key blocks before Plaid is asked to exchange anything", async () => {
    vi.stubEnv("YOMI_SECRET_KEY", "nope");
    const db = await legacyDb();
    const p = fakeProvider();
    let exchanged = 0;
    p.exchangePublicToken = async () => {
      exchanged += 1;
      return { accessToken: ACCESS, enrollmentId: "item_9" };
    };
    await expect(connectWithPublicToken(db, user, p, { publicToken: "public-9", institutionName: null })).rejects.toMatchObject({ code: "bank_secret_malformed" });
    expect(exchanged).toBe(0);
    expect(await secretsHealth(db)).toMatchObject({ errorCode: "bank_secret_malformed", error: expect.stringContaining("malformed") });
  });
});

/** Files under `root` (recursively) whose bytes contain `needle`. */
function filesHolding(root: string, needle: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(root, { withFileTypes: true, recursive: true })) {
    if (!e.isFile()) continue;
    const f = path.join(e.parentPath, e.name);
    if (readFileSync(f).includes(needle)) out.push(path.relative(root, f));
  }
  return out;
}

// Each test boots several PGlite instances; under a loaded machine that exceeds the 5 s default.
describe("scrubBackupFile: PGlite backup tarballs", { timeout: 30_000 }, () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "yomi-scrub-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  /** A pre-encrypt backup as backupDatabase writes it: a gzip tarball of the data directory, tokens in plaintext. */
  async function backupWithPlaintext(): Promise<string> {
    const db = await legacyDb();
    const file = path.join(dir, "live-20260929-120000-pre-encrypt.tar.gz");
    writeFileSync(file, new Uint8Array(await (await pgliteOf(db)!.dumpDataDir("gzip")).arrayBuffer()));
    return file;
  }
  const sha = (f: string) => createHash("sha256").update(readFileSync(f)).digest("hex");
  /** The tarball's uncompressed bytes (the data directory's files). */
  const unpacked = (f: string) => gunzipSync(readFileSync(f));

  it("dry run counts plaintext tokens and leaves the file byte-identical", async () => {
    const file = await backupWithPlaintext();
    const before = sha(file);
    expect(await scrubBackupFile(file)).toEqual({ file, plaintext: 2, encrypted: 0, rewritten: 0, error: null });
    expect(sha(file)).toBe(before);
    expect(readdirSync(dir).filter((f) => f.startsWith("live-"))).toEqual(["live-20260929-120000-pre-encrypt.tar.gz"]);
  });

  it("apply encrypts in place, verifies, removes the plaintext bytes, keeps the rest, and is idempotent", async () => {
    const file = await backupWithPlaintext();
    expect(unpacked(file).includes(ACCESS)).toBe(true);
    const r = await scrubBackupFile(file, { key: key() });
    expect(r).toMatchObject({ plaintext: 2, rewritten: 2, error: null });
    expect(unpacked(file).includes(ACCESS)).toBe(false);
    expect(unpacked(file).includes("link-production-legacy")).toBe(false);
    expect(readdirSync(dir)).toEqual(["live-20260929-120000-pre-encrypt.tar.gz"]);

    const db = await openBackupFile(file);
    try {
      expect(decryptSecret((await db.select().from(bankConnections).where(eq(bankConnections.enrollmentId, "item_1")).limit(1))[0]!.accessToken, key())).toBe(ACCESS);
      expect(await db.select().from(bankConnections)).toHaveLength(2);
      // In place of SQLite's integrity_check: every table of the rewritten data directory reads back in full.
      const tables = await listTables(db);
      expect(tables).toEqual(expect.arrayContaining(["bank_connections", "plaid_link_sessions", "transactions"]));
      for (const t of tables) await queryRows(db, sql.raw(`select * from "${t}"`));
    } finally {
      await closeDb(db);
    }

    expect(await scrubBackupFile(file, { key: key() })).toMatchObject({ plaintext: 0, encrypted: 2, rewritten: 0, error: null });
  });

  it("an old backup without the token tables or a file that is not a tarball is reported, never changed", async () => {
    const old = path.join(dir, "old-20260101-000000-pre-import.tar.gz");
    const bare = await isolatedTestDb();
    try {
      await bare.execute(sql`drop table bank_connections, plaid_link_sessions cascade`);
      writeFileSync(old, new Uint8Array(await (await pgliteOf(bare)!.dumpDataDir("gzip")).arrayBuffer()));
    } finally {
      await closeDb(bare);
    }
    const before = sha(old);
    expect(await scrubBackupFile(old, { key: key() })).toMatchObject({ plaintext: 0, encrypted: 0, rewritten: 0, error: null });
    expect(sha(old)).toBe(before);
    const junk = path.join(dir, "junk.tar.gz");
    writeFileSync(junk, "not a tarball");
    const r = await scrubBackupFile(junk, { key: key() });
    expect(r.error).toBeTruthy();
    expect(readFileSync(junk, "utf8")).toBe("not a tarball");
  });
});
