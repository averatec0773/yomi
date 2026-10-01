import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { BackupResult, PAYMENT_KINDS, PaymentMethodInput, PaymentMethodsSetting, ProfileSetting, QuickCreated, QuickDraft, SettingsStatus, Statement } from "@yomi/contracts";
import {
  PAYMENT_KINDS as CORE_PAYMENT_KINDS,
  createParticipant,
  getCurrentUser,
  listParticipants,
  looksLikeEmail,
  looksLikePhone,
  resolveContact,
  seed,
} from "@yomi/core";
import { closeDb, createDb, type Db, migrate, transactions, transactionSplits, userSettings } from "@yomi/db";
import { testDb, migratedTestDir } from "@yomi/db/testing";
import { describe, expect, it } from "vitest";
import { createApi } from "./index";

const user = getCurrentUser();

async function setup() {
  const db = await testDb();
  await seed(db);
  return { db, app: createApi({ getDb: () => db }) };
}

async function addSplitExpense(db: Db, roomie: number) {
  const self = (await listParticipants(db, user)).find((p) => p.isSelf)!.id;
  const tx = (
    await db
      .insert(transactions)
      .values({
        userId: 1,
        occurredAt: "2026-09-03T12:00:00+08:00",
        amountMinor: -3500,
        currency: "CNY",
        kind: "expense",
        source: "manual",
        dedupKey: "m:1",
        merchant: "午饭, 面馆",
      })
      .returning({ id: transactions.id })
  )[0]!.id;
  for (const [pid, owed, paid] of [
    [self, 1750, 3500],
    [roomie, 1750, 0],
  ] as const) {
    await db.insert(transactionSplits).values({ userId: 1, transactionId: tx, participantId: pid, currency: "CNY", owedMinor: owed, paidMinor: paid, method: "equal" });
  }
}

describe("export and backup routes", () => {
  it("GET /api/export/transactions.csv is a UTF-8 CSV attachment with a BOM", async () => {
    const { db, app } = await setup();
    const roomie = (await createParticipant(db, user, "室友")).id;
    await addSplitExpense(db, roomie);

    const res = await app.request("/api/export/transactions.csv?month=2026-09");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/csv; charset=utf-8");
    expect(res.headers.get("content-disposition")).toMatch(/^attachment; filename="yomi-transactions-2026-09\.csv"/);
    const bytes = new Uint8Array(await res.arrayBuffer());
    expect([...bytes.slice(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    const text = new TextDecoder().decode(bytes);
    expect(text).toContain('"午饭, 面馆"');
    expect(text).toContain("室友 17.50; Me 17.50");
    const zh = new TextDecoder().decode(new Uint8Array(await (await app.request("/api/export/transactions.csv?month=2026-09&locale=zh-CN")).arrayBuffer()));
    expect(zh).toContain("室友 17.50; 我 17.50");

    expect((await app.request("/api/export/transactions.csv?month=2026-9")).status).toBe(400);
    expect((await app.request("/api/export/transactions.csv")).status).toBe(200);
  });

  it("GET /api/export/split.csv exports the statement; unknown participant is 404", async () => {
    const { db, app } = await setup();
    const roomie = (await createParticipant(db, user, "室友")).id;
    await addSplitExpense(db, roomie);
    const res = await app.request(`/api/export/split.csv?participantId=${roomie}&currency=CNY`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-disposition")).toContain(`yomi-split-${roomie}-CNY.csv`);
    const text = await res.text();
    expect(text).toContain("Shared expense");
    expect(await (await app.request(`/api/export/split.csv?participantId=${roomie}&currency=CNY&locale=zh-CN`)).text()).toContain("共同支出");
    expect(text).toContain("17.50");
    expect((await app.request("/api/export/split.csv?participantId=999&currency=CNY")).status).toBe(404);
    expect((await app.request("/api/export/split.csv?currency=CNY")).status).toBe(400);
    const tx = (await db.select().from(transactions).limit(1))[0]!.id;
    const sel = await (await app.request(`/api/export/split.csv?participantId=${roomie}&currency=CNY&scope=selected&items=${tx}`)).text();
    expect(sel).toContain("Total of these items,,,,,17.50,室友 owes me");
    expect((await app.request(`/api/export/split.csv?participantId=${roomie}&currency=CNY&scope=selected&items=99999`)).status).toBe(400);
  });

  it("POST /api/maintenance/backup writes a tarball next to a PGlite directory; in-memory is 409", async () => {
    const mem = await (await setup()).app.request("/api/maintenance/backup", { method: "POST" });
    expect(mem.status).toBe(409);
    expect(await mem.json()).toMatchObject({ code: "backup_in_memory" });

    const dir = mkdtempSync(path.join(tmpdir(), "yomi-api-backup-"));
    try {
      await migratedTestDir(path.join(dir, "pglite"));
      const db = await createDb(path.join(dir, "pglite"));
      try {
        await migrate(db);
        await seed(db);
        const res = await createApi({ getDb: () => db }).request("/api/maintenance/backup", { method: "POST" });
        expect(res.status).toBe(200);
        const out = BackupResult.parse(await res.json());
        expect(out.fileName).toMatch(/^pglite-\d{8}-\d{6}-manual\.tar\.gz$/);
        expect(out.path).toBe(path.join(dir, "backups", out.fileName));
        expect(existsSync(out.path)).toBe(true);
      } finally {
        await closeDb(db);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("GET /api/settings/status reports setup without secrets", async () => {
    const res = await (await setup()).app.request("/api/settings/status");
    expect(res.status).toBe(200);
    const body = SettingsStatus.parse(await res.json());
    expect(body.security.encryptedTokens + body.security.plaintextTokens).toBe(0);
    expect(body.plaid.bankConnections).toBe(0);
    const text = JSON.stringify(body);
    for (const k of ["PLAID_SECRET_PRODUCTION", "PLAID_SECRET_SANDBOX", "IBKR_FLEX_TOKEN", "YOMI_SECRET_KEY"]) {
      const v = process.env[k]?.trim();
      if (v) expect(text).not.toContain(v);
    }
  });
});

describe("quick add with a pasted ICBC alert", () => {
  const SMS = "您尾号3141信用卡9月27日08:24POS支出(消费BUSY BEE BOBA Houston)15.74美元。【工商银行】";

  it("parses, saves once and reports a repeat paste", async () => {
    const { db, app } = await setup();
    const parsed = QuickDraft.parse(await (await app.request("/api/quick/parse", { method: "POST", body: JSON.stringify({ text: SMS, today: "2026-09-29" }) })).json());
    expect(parsed.sms).toMatchObject({ last4: "3141", merchant: "BUSY BEE BOBA", amountMinor: -1574 });
    const body = JSON.stringify({ ...parsed, errors: undefined, smsText: SMS, today: "2026-09-29" });
    const first = await app.request("/api/quick", { method: "POST", body });
    expect(first.status).toBe(201);
    expect(QuickCreated.parse(await first.json())).toMatchObject({ alreadyAdded: false, duplicateOfId: null });
    const again = await app.request("/api/quick", { method: "POST", body });
    expect(again.status).toBe(200);
    expect(QuickCreated.parse(await again.json())).toMatchObject({ alreadyAdded: true });
    expect((await db.select().from(transactions)).map((t) => t.source)).toEqual(["sms"]);
  });
});

describe("time zone routes", () => {
  const put = (app: Awaited<ReturnType<typeof setup>>["app"], body: unknown) =>
    app.request("/api/settings/time-zone", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

  it("stores the browser zone once (ifUnset), then only an explicit change", async () => {
    const { app } = await setup();
    expect(await (await app.request("/api/settings/time-zone")).json()).toEqual({ timeZone: "America/Chicago", isSet: false });
    expect(await (await put(app, { timeZone: "America/New_York", ifUnset: true })).json()).toMatchObject({ timeZone: "America/New_York", isSet: true });
    expect(await (await put(app, { timeZone: "Europe/Paris", ifUnset: true })).json()).toMatchObject({ timeZone: "America/New_York", changed: 0 });
    expect(await (await put(app, { timeZone: "Europe/Paris" })).json()).toMatchObject({ timeZone: "Europe/Paris", isSet: true });
    const bad = await put(app, { timeZone: "Nowhere/Land" });
    expect(bad.status).toBe(400);
    expect(await bad.json()).toMatchObject({ code: "invalid_time_zone" });
  });
});

describe("shortcut routes", () => {
  const put = (app: Awaited<ReturnType<typeof setup>>["app"], body: unknown) =>
    app.request("/api/settings/shortcuts", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

  it("stores overrides only, refuses conflicts and unusable keys, and resets with {}", async () => {
    const { app } = await setup();
    expect(await (await app.request("/api/settings/shortcuts")).json()).toEqual({ overrides: {} });
    // A key equal to its default is not stored.
    expect(await (await put(app, { overrides: { leader: ";", goStats: "m" } })).json()).toEqual({ overrides: { leader: ";" } });
    expect(await (await app.request("/api/settings/shortcuts")).json()).toEqual({ overrides: { leader: ";" } });

    const clash = await put(app, { overrides: { goStats: "t" } });
    expect(clash.status).toBe(400);
    expect(await clash.json()).toMatchObject({ code: "invalid_shortcuts", params: { action: "goTransactions", key: "t", problem: "conflict" } });
    expect((await put(app, { overrides: { leader: " " } })).status).toBe(400);
    expect((await put(app, { overrides: { leader: "" } })).status).toBe(400);
    expect((await put(app, { overrides: { nope: "q" } })).status).toBe(400);
    // Unchanged after the refusals.
    expect(await (await app.request("/api/settings/shortcuts")).json()).toEqual({ overrides: { leader: ";" } });

    expect(await (await put(app, { overrides: {} })).json()).toEqual({ overrides: {} });
  });
});

describe("profile routes", () => {
  const put = (app: Awaited<ReturnType<typeof setup>>["app"], body: unknown) =>
    app.request("/api/settings/profile", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const header = async (app: Awaited<ReturnType<typeof setup>>["app"], roomie: number) =>
    (await (await app.request(`/api/export/split.csv?participantId=${roomie}&currency=CNY&show=myshare`)).text()).split(/\r?\n/)[0];

  it("stores a trimmed display name, labels the CSV share column with it, and clears it with an empty name", async () => {
    const { db, app } = await setup();
    const none = { email: null, phone: null };
    expect(await (await app.request("/api/settings/profile")).json()).toEqual({ displayName: null, ...none });
    expect(await (await put(app, { displayName: "  Sam  " })).json()).toEqual({ displayName: "Sam", ...none });
    expect(await (await app.request("/api/settings/profile")).json()).toEqual({ displayName: "Sam", ...none });
    const roomie = (await createParticipant(db, user, "Alex")).id;
    await addSplitExpense(db, roomie);
    expect(await header(app, roomie)).toMatch(/,Sam's share$/);
    expect((await put(app, { displayName: "x".repeat(41) })).status).toBe(400);
    expect(await (await put(app, { displayName: "   " })).json()).toEqual({ displayName: null, ...none });
    expect(await header(app, roomie)).toMatch(/,My share$/);
  });

  it("stores the email and phone payment methods show; only the fields sent change, with the payment checks", async () => {
    const { db, app } = await setup();
    expect(await (await put(app, { displayName: "Sam" })).json()).toEqual({ displayName: "Sam", email: null, phone: null });
    expect(await (await put(app, { email: " alex@example.com " })).json()).toEqual({ displayName: "Sam", email: "alex@example.com", phone: null });
    // Phones are stored as E.164; without a "+" a number reads as US; a number that is not valid is refused.
    expect(await (await put(app, { phone: "(202) 555-0143" })).json()).toEqual({ displayName: "Sam", email: "alex@example.com", phone: "+12025550143" });
    expect((await put(app, { email: "alex at example" })).status).toBe(400);
    expect((await put(app, { phone: "call me" })).status).toBe(400);
    expect((await put(app, { phone: "+1 555 010 0100" })).status).toBe(400);
    expect((await put(app, { phone: "138 0013 8000" })).status).toBe(400);

    // A Zelle method showing both: the statement lists the profile values, and follows a profile change.
    const methods = (b: unknown) =>
      app.request("/api/settings/payment-methods", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(b) });
    expect((await methods({ methods: [{ kind: "zelle", useProfileEmail: true, useProfilePhone: true, currencies: ["CNY"] }] })).status).toBe(200);
    const roomie = (await createParticipant(db, user, "Alex")).id;
    await addSplitExpense(db, roomie);
    const text = async () => Statement.parse(await (await app.request(`/api/split/statement?participantId=${roomie}&currency=CNY`)).json()).text;
    // A US number on a CNY statement carries +1; a Chinese number is international.
    expect(await text()).toContain("My payment details:\nZelle: alex@example.com  +1 202-555-0143");
    expect(await (await put(app, { phone: "+86 138 0013 8000" })).json()).toMatchObject({ phone: "+8613800138000" });
    expect(await text()).toContain("My payment details:\nZelle: alex@example.com  +86 138 0013 8000");
    expect(await (await put(app, { email: "", phone: null })).json()).toEqual({ displayName: "Sam", email: null, phone: null });
    expect(await text()).not.toContain("My payment details");
  });
});

describe("payment method routes", () => {
  const put = (app: Awaited<ReturnType<typeof setup>>["app"], body: unknown) =>
    app.request("/api/settings/payment-methods", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

  it("stores the list with defaults, refuses invalid lists, and statements pick it up", async () => {
    const { db, app } = await setup();
    expect(await (await app.request("/api/settings/payment-methods")).json()).toEqual({ methods: [] });
    const stored = await (
      await put(app, {
        methods: [
          { kind: "wechat", text: "alex-demo" },
          { kind: "zelle", email: "alex@example.com", phone: "202-555-0143", label: "Zelle (Chase)", currencies: ["CNY"] },
        ],
      })
    ).json();
    expect(PaymentMethodsSetting.parse(stored).methods[1]!.phone).toBe("+12025550143");
    expect(PaymentMethodsSetting.parse(stored).methods.map((m) => [m.kind, m.currencies, m.showOnStatement])).toEqual([
      ["wechat", ["CNY"], true],
      ["zelle", ["CNY"], true],
    ]);
    expect((await put(app, { methods: Array(7).fill({ kind: "venmo", username: "@alex-demo" }) })).status).toBe(400);
    expect((await put(app, { methods: [{ kind: "zelle", email: "" }] })).status).toBe(400);
    expect((await put(app, { methods: [{ kind: "zelle", email: "alex at example" }] })).status).toBe(400);
    expect((await put(app, { methods: [{ kind: "zelle", phone: "call me" }] })).status).toBe(400);
    // A method's own phone saved before v0.1.30 that is not a valid number is kept as typed, so its list still saves.
    expect(PaymentMethodsSetting.parse(await (await put(app, { methods: [{ kind: "zelle", phone: "+1 555 010 0100" }] })).json()).methods[0]!.phone).toBe("+1 555 010 0100");
    await put(app, stored);
    expect(PAYMENT_KINDS).toEqual([...CORE_PAYMENT_KINDS]);

    const roomie = (await createParticipant(db, user, "Alex")).id;
    await addSplitExpense(db, roomie);
    const st = Statement.parse(await (await app.request(`/api/split/statement?participantId=${roomie}&currency=CNY`)).json());
    expect(st.payment.map((m) => m.kind)).toEqual(["wechat", "zelle"]);
    expect(st.text).toContain("My payment details:\nWeChat Pay: alex-demo\nZelle (Chase): alex@example.com  +1 202-555-0143");
    // The CSV stays as it was.
    expect(await (await app.request(`/api/export/split.csv?participantId=${roomie}&currency=CNY`)).text()).not.toContain("alex");
    expect(await (await put(app, { methods: [] })).json()).toEqual({ methods: [] });
  });

  it("serves values saved with one handle in the new shape, and saving that list back passes the contract", async () => {
    const { db, app } = await setup();
    const old = [
      { kind: "zelle", label: "Zelle (Chase)", handle: "alex@example.com", qr: null, currencies: ["USD"], showOnStatement: true },
      { kind: "zelle", label: null, handle: "+1 555 0100", qr: null, currencies: ["USD"], showOnStatement: true },
      { kind: "zelle", label: null, handle: "alexdemo", qr: null, currencies: ["USD"], showOnStatement: true },
      { kind: "venmo", label: null, handle: "alex@example.com", qr: null, currencies: ["USD"], showOnStatement: true },
      { kind: "other", label: "Bank transfer", handle: "https://example.com/pay/alex-demo", qr: null, currencies: ["USD"], showOnStatement: true },
    ];
    await db.insert(userSettings).values({ userId: user.id, key: "payment_methods", value: JSON.stringify(old) });
    const { methods } = PaymentMethodsSetting.parse(await (await app.request("/api/settings/payment-methods")).json());
    // The email and phone moved to the profile (v0.1.29); resolved, every old value is still there.
    const profile = ProfileSetting.parse(await (await app.request("/api/settings/profile")).json());
    expect(profile).toMatchObject({ email: "alex@example.com", phone: "+1 555 0100" });
    expect(methods.map((m) => resolveContact(m, profile)).map((c) => c.email ?? c.phone ?? c.username ?? c.text)).toEqual(old.map((m) => m.handle));
    expect((await put(app, { methods })).status).toBe(200);
  });

  it("core's email and phone checks (used to upgrade old values) agree with the contract", () => {
    const samples = ["alex@example.com", "alex@example", "@alex-demo", "+1 555 0100", "(555) 010-0100", "555 01", "$alexdemo", "+1 555.010.0100", "a b@c.d"];
    for (const v of samples) {
      expect(PaymentMethodInput.safeParse({ kind: "zelle", email: v }).success, v).toBe(looksLikeEmail(v));
      expect(PaymentMethodInput.safeParse({ kind: "zelle", phone: v }).success, v).toBe(looksLikePhone(v));
    }
  });
});

describe("theme routes", () => {
  const put = (app: Awaited<ReturnType<typeof setup>>["app"], body: unknown) =>
    app.request("/api/settings/theme", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

  it("defaults to system, stores light and dark, refuses unknown values", async () => {
    const { app } = await setup();
    expect(await (await app.request("/api/settings/theme")).json()).toEqual({ theme: "system" });
    expect(await (await put(app, { theme: "light" })).json()).toEqual({ theme: "light" });
    expect(await (await app.request("/api/settings/theme")).json()).toEqual({ theme: "light" });
    expect(await (await put(app, { theme: "dark" })).json()).toEqual({ theme: "dark" });
    expect((await put(app, { theme: "sepia" })).status).toBe(400);
    expect((await put(app, {})).status).toBe(400);
    expect(await (await app.request("/api/settings/theme")).json()).toEqual({ theme: "dark" });
    expect(await (await put(app, { theme: "system" })).json()).toEqual({ theme: "system" });
  });
});
