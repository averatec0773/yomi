import { accounts, bankAccounts, bankConnections, importBatches } from "@yomi/db";
import { eq } from "@yomi/db/orm";
import type { NormalizedRow, ParseResult } from "@yomi/importers";
import { describe, expect, it } from "vitest";
import { commitImport, revertBatch } from "../import/pipeline";
import { addTx, freshDb, user } from "../ledger/test-helpers";
import {
  attentionItems,
  loadSourceActivity,
  loadSourceFacts,
  periodCompleteness,
  type SourceFacts,
  sourceFreshness,
} from "./freshness";

const base = { label: null, lastOn: null, status: "active" as const, errorCode: null, expectedThrough: null, currencies: [] };
const fact = (p: Partial<SourceFacts> & Pick<SourceFacts, "key" | "source" | "kind">): SourceFacts => ({ ...base, through: null, ...p });
const TODAY = "2026-09-30";

describe("sourceFreshness", () => {
  it("is behind when the data ends before yesterday, and reminds about exports older than a week", () => {
    const out = sourceFreshness(
      [
        fact({ key: "plaid:1", source: "plaid", kind: "stream", through: "2026-09-29" }),
        fact({ key: "plaid:2", source: "plaid", kind: "stream", through: "2026-09-28", status: "error", errorCode: "ITEM_LOGIN_REQUIRED" }),
        fact({ key: "alipay", source: "alipay", kind: "export", through: "2026-09-29" }),
        fact({ key: "wechat", source: "wechat", kind: "export", through: "2026-09-24" }),
        fact({ key: "icbc_pdf", source: "icbc_pdf", kind: "export", through: "2026-09-22" }),
        fact({ key: "boa_csv", source: "boa_csv", kind: "export", through: null }),
        fact({ key: "sms", source: "sms", kind: "capture", lastOn: "2026-09-12" }),
        fact({ key: "ibkr", source: "ibkr", kind: "investments", through: "2026-09-28", expectedThrough: "2026-09-29", status: "waiting" }),
        fact({ key: "plaid_investments:3", source: "plaid_investments", kind: "investments", through: "2026-09-29", expectedThrough: null }),
        fact({ key: "plaid:4", source: "plaid", kind: "stream", through: "2026-09-01", status: "paused" }),
      ],
      TODAY,
    );
    expect(out.map((f) => [f.key, f.state, f.exportReminder])).toEqual([
      ["plaid:1", "current", false],
      ["plaid:2", "error", false],
      ["alipay", "current", false],
      ["wechat", "behind", false],
      ["icbc_pdf", "behind", true],
      ["boa_csv", "never", true],
      ["sms", "current", false],
      ["ibkr", "behind", false],
      ["plaid_investments:3", "current", false],
      ["plaid:4", "paused", false],
    ]);
  });
});

describe("periodCompleteness", () => {
  const fresh = sourceFreshness(
    [
      fact({ key: "alipay", source: "alipay", kind: "export", through: "2026-09-29" }),
      fact({ key: "wechat", source: "wechat", kind: "export", through: "2026-09-24" }),
      fact({ key: "plaid:1", source: "plaid", kind: "stream", through: "2026-09-28" }),
      fact({ key: "sms", source: "sms", kind: "capture", lastOn: "2026-09-01" }),
      fact({ key: "ibkr", source: "ibkr", kind: "investments", through: "2026-08-01" }),
    ],
    TODAY,
  );
  const activity = [
    { key: "alipay", currency: "CNY" },
    { key: "wechat", currency: "CNY" },
    { key: "plaid:1", currency: "USD" },
    { key: "sms", currency: "USD" },
  ];

  it("marks only the currencies of the sources that end early", () => {
    expect(periodCompleteness(fresh, activity, { from: "2026-09-28", to: "2026-10-04" }, TODAY)).toEqual({ CNY: ["wechat"], USD: ["plaid:1"] });
    // A week that ended before WeChat's data does: complete.
    expect(periodCompleteness(fresh, activity, { from: "2026-09-14", to: "2026-09-20" }, TODAY)).toEqual({});
    // Sep 25 is after WeChat's last day; Plaid covers it.
    expect(periodCompleteness(fresh, activity, { from: "2026-09-25", to: "2026-09-25" }, TODAY)).toEqual({ CNY: ["wechat"] });
  });

  it("ignores sources without rows in the activity window", () => {
    expect(periodCompleteness(fresh, [{ key: "alipay", currency: "CNY" }], { from: "2026-09-28", to: "2026-10-04" }, TODAY)).toEqual({});
  });
});

describe("attentionItems", () => {
  it("lists failing Plaid logins and a late or failing IBKR", () => {
    const fresh = sourceFreshness(
      [
        fact({ key: "plaid:1", source: "plaid", kind: "stream", through: "2026-09-29" }),
        fact({ key: "plaid:2", source: "plaid", kind: "stream", label: "Pine Credit Union", status: "error", errorCode: "ITEM_LOGIN_REQUIRED" }),
        fact({ key: "ibkr", source: "ibkr", kind: "investments", through: "2026-09-28", expectedThrough: "2026-09-29", status: "waiting" }),
      ],
      TODAY,
    );
    expect(attentionItems(fresh)).toEqual([
      { kind: "plaid", key: "plaid:2", label: "Pine Credit Union", errorCode: "ITEM_LOGIN_REQUIRED" },
      { kind: "ibkr", key: "ibkr", state: "waiting", errorCode: null, through: "2026-09-28", expectedThrough: "2026-09-29" },
    ]);
  });
});

let line = 0;
const alipayRow = (day: string, minor: number): NormalizedRow => ({
  lineNo: ++line,
  source: "alipay",
  externalId: `fixture-${line}`,
  occurredAt: `${day}T12:00:00+08:00`,
  amountMinor: -minor,
  currency: "CNY",
  originalAmountMinor: null,
  originalCurrency: null,
  direction: "out",
  kind: "expense",
  status: "ok",
  counterparty: "Maple Noodles",
  description: "",
  sourceCategory: null,
  paymentMethod: null,
  raw: { note: "fictional" },
});

describe("loadSourceFacts and loadSourceActivity", () => {
  it("reads the coverage commitImport stores, Plaid logins and captures; a revert drops the batch", async () => {
    const db = await freshDb();
    const parsed: ParseResult = {
      source: "alipay",
      rows: [alipayRow("2026-09-10", 1800), alipayRow("2026-09-20", 2600)],
      declared: {},
      periodStart: "2026-09-01T00:00:00+08:00",
      periodEnd: "2026-09-26T09:30:00+08:00",
      warnings: [],
    };
    const r = await commitImport(db, user, async () => parsed, new TextEncoder().encode("fixture-alipay"), "fixture.csv", { backup: false });
    const batch = (await db.select().from(importBatches).where(eq(importBatches.id, r.batchId)))[0]!;
    expect([batch.periodStart, batch.periodEnd]).toEqual(["2026-09-01", "2026-09-25"]);

    const conn = (await db
      .insert(bankConnections)
      .values({ userId: user.id, provider: "plaid", kind: "bank", enrollmentId: "fixture-item", institutionName: "Pine Credit Union", accessToken: "", lastSyncedAt: "2026-09-29T18:00:00.000Z" })
      .returning())[0]!;
    const acct = (await db.insert(accounts).values({ userId: user.id, name: "Pine checking 5501", kind: "debit_card", last4: "5501", currency: "USD" }).returning())[0]!.id;
    await addTx(db, { amountMinor: -500, currency: "USD", source: "plaid", accountId: acct, occurredAt: "2026-09-27T12:00:00-05:00" });
    await db.insert(bankAccounts).values({ userId: user.id, connectionId: conn.id, providerAccountId: "fixture-chk", accountId: acct, name: "Checking", type: "depository", lastFour: "5501", currency: "USD" });
    await addTx(db, { amountMinor: -900, currency: "USD", source: "sms", createdAt: "2026-09-21T02:00:00.000Z", occurredAt: "2026-09-20T20:00:00-05:00" });

    const facts = await loadSourceFacts(db, user, { timeZone: "America/Chicago", env: {}, now: new Date("2026-09-30T17:00:00Z") });
    expect(facts.map((f) => [f.key, f.kind, f.through, f.lastOn, f.currencies])).toEqual([
      [`plaid:${conn.id}`, "stream", "2026-09-28", null, ["USD"]],
      ["alipay", "export", "2026-09-25", null, ["CNY"]],
      ["sms", "capture", null, "2026-09-20", ["USD"]],
    ]);
    const activity = await loadSourceActivity(db, user, { from: "2026-09-28", to: "2026-10-04" });
    expect(activity.sort((a, b) => a.key.localeCompare(b.key))).toEqual([
      { key: "alipay", currency: "CNY" },
      { key: `plaid:${conn.id}`, currency: "USD" },
      { key: "sms", currency: "USD" },
    ]);

    await revertBatch(db, user, r.batchId, { backup: false });
    expect((await loadSourceFacts(db, user, { timeZone: "America/Chicago", env: {} })).map((f) => f.key)).toEqual([`plaid:${conn.id}`, "sms"]);
  });

  it("falls back to the newest row when no batch states its period", async () => {
    const db = await freshDb();
    await addTx(db, { amountMinor: -700, source: "wechat", occurredAt: "2026-09-18T09:00:00+08:00" });
    const facts = await loadSourceFacts(db, user, { timeZone: "Asia/Shanghai", env: {} });
    expect(facts).toEqual([expect.objectContaining({ key: "wechat", through: "2026-09-18", currencies: ["CNY"] })]);
  });
});
