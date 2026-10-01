import { type Db, transactions, userSettings } from "@yomi/db";
import { testDb } from "@yomi/db/testing";
import type { NormalizedRow, ParseResult } from "@yomi/importers";
import { eq } from "@yomi/db/orm";
import { describe, expect, it } from "vitest";
import { exportTransactionsCsv } from "../export/csv";
import { commitParsed } from "../import/pipeline";
import { addTx, freshDb, user } from "../ledger/test-helpers";
import { listMonths, listTransactions, rangeTotalsForList } from "../ledger/transactions";
import { createQuickEntry } from "../quick/create";
import { createSmsEntry } from "../quick/sms";
import { seed } from "../seed";
import { rangeOverview } from "../stats/range";
import { ensureOccurredOn, getTimeZoneSetting, recomputeOccurredOn, setTimeZone } from "./time-zone";

const dayOf = async (db: Db, id: number) => (await db.select({ d: transactions.occurredOn }).from(transactions).where(eq(transactions.id, id)).limit(1))[0]!.d;

describe("time zone setting", () => {
  it("defaults to America/Chicago until set, and rejects unknown zones", async () => {
    const db = await testDb();
    await seed(db);
    expect(await getTimeZoneSetting(db, user)).toEqual({ timeZone: "America/Chicago", isSet: false });
    expect(await setTimeZone(db, user, "Europe/Berlin")).toMatchObject({ timeZone: "Europe/Berlin", isSet: true });
    expect(await getTimeZoneSetting(db, user)).toEqual({ timeZone: "Europe/Berlin", isSet: true });
    await expect(setTimeZone(db, user, "Nowhere/Land")).rejects.toThrow(/Unknown time zone/);
  });
});

describe("the occurred_on insert trigger and the startup backfill", () => {
  // The SQLite ledger gained occurred_on in migration 0008, which filled old rows with the source date. The
  // Postgres baseline has the column from the start; rows written without it (occurred_on '') get the source
  // date from the insert trigger, and nothing has recorded the zone they were grouped in yet.
  it("rows written without occurred_on get the source date, then ensureOccurredOn regroups in the default zone once", async () => {
    const db = await testDb();
    await seed(db);
    const row = (occurredAt: string, source: (typeof transactions.$inferInsert)["source"], dedupKey: string): typeof transactions.$inferInsert =>
      ({ userId: user.id, occurredAt, occurredOn: "", amountMinor: -100, currency: "CNY", kind: "expense", source, dedupKey });
    await db.insert(transactions).values([
      row("2026-09-18T08:30:00+08:00", "icbc_pdf", "a"), // evening of the 17th in Chicago
      row("2026-09-18T20:00:00+08:00", "alipay", "b"), // 07:00 on the 18th in Chicago
      row("2026-09-17T12:00:00-05:00", "plaid", "c"), // date-only
    ]);
    const days = async () => (await db.select({ d: transactions.occurredOn }).from(transactions).orderBy(transactions.id)).map((r) => r.d);
    expect(await days()).toEqual(["2026-09-18", "2026-09-18", "2026-09-17"]);

    expect(await ensureOccurredOn(db, user)).toBe(1);
    expect(await days()).toEqual(["2026-09-17", "2026-09-18", "2026-09-17"]);
    expect(await ensureOccurredOn(db, user)).toBe(0);
    // No zone was chosen yet: the browser can still post its own.
    expect((await getTimeZoneSetting(db, user)).isSet).toBe(false);
  });

  it("an insert that leaves occurred_on out gets the source date from the trigger", async () => {
    const db = await freshDb();
    const id = (await db
      .insert(transactions)
      .values({ userId: user.id, occurredAt: "2026-09-18T08:30:00+08:00", amountMinor: -1, currency: "CNY", kind: "expense", source: "manual", dedupKey: "m" })
      .returning({ id: transactions.id }))[0]!.id;
    expect(await dayOf(db, id)).toBe("2026-09-18");
  });
});

describe("recompute on zone change", () => {
  it("regroups every row and records the zone it used", async () => {
    const db = await freshDb(); // Asia/Shanghai
    const late = await addTx(db, { amountMinor: -500, occurredAt: "2026-10-01T08:00:00+08:00", source: "icbc_pdf" });
    const noon = await addTx(db, { amountMinor: -700, occurredAt: "2026-09-15T20:00:00+08:00" });
    const manual = await addTx(db, { amountMinor: -900, occurredAt: "2026-09-30T12:00:00+08:00", source: "manual" });
    expect([await dayOf(db, late), await dayOf(db, noon), await dayOf(db, manual)]).toEqual(["2026-10-01", "2026-09-15", "2026-09-30"]);

    expect((await setTimeZone(db, user, "America/Chicago")).changed).toBe(1);
    expect([await dayOf(db, late), await dayOf(db, noon), await dayOf(db, manual)]).toEqual(["2026-09-30", "2026-09-15", "2026-09-30"]);
    expect((await db.select().from(userSettings)).map((s) => [s.key, s.value])).toEqual(
      expect.arrayContaining([
        ["timeZone", "America/Chicago"],
        ["occurredOnZone", "America/Chicago"],
      ]),
    );
    expect(await recomputeOccurredOn(db, user)).toBe(0);
    expect((await setTimeZone(db, user, "Asia/Shanghai")).changed).toBe(1);
    expect(await dayOf(db, late)).toBe("2026-10-01");
  });
});

describe("filters and totals read occurred_on", () => {
  async function setup() {
    const db = await freshDb();
    // Beijing 08:00 on Oct 1 = Sep 30 19:00 in Chicago; Beijing 12:00 on Sep 10 = Sep 9 23:00 in Chicago.
    const edge = await addTx(db, { amountMinor: -500, occurredAt: "2026-10-01T08:00:00+08:00", source: "icbc_pdf" });
    const mid = await addTx(db, { amountMinor: -1200, occurredAt: "2026-09-10T12:00:00+08:00" });
    await addTx(db, { amountMinor: -300, occurredAt: "2026-09-20T15:00:00+08:00" });
    return { db, edge, mid };
  }

  it("month, from/to, month list and CSV follow the user's day", async () => {
    const { db, edge, mid } = await setup();
    expect((await listTransactions(db, user, { month: "2026-10" })).items.map((t) => t.id)).toEqual([edge]);
    await setTimeZone(db, user, "America/Chicago");
    expect((await listTransactions(db, user, { month: "2026-10" })).total).toBe(0);
    const sept = (await listTransactions(db, user, { month: "2026-09" })).items;
    expect(sept.map((t) => t.id)[0]).toBe(edge);
    expect(sept.find((t) => t.id === edge)).toMatchObject({ occurredAt: "2026-10-01T08:00:00+08:00", occurredOn: "2026-09-30" });
    expect((await listTransactions(db, user, { from: "2026-09-09", to: "2026-09-09" })).items.map((t) => t.id)).toEqual([mid]);
    expect((await listTransactions(db, user, { from: "2026-09-30", to: "2026-09-30" })).items.map((t) => t.id)).toEqual([edge]);
    expect(await listMonths(db, user)).toEqual([{ month: "2026-09", count: 3 }]);
    const csv = await exportTransactionsCsv(db, user, { month: "2026-09" });
    expect(csv).toContain("2026-09-30,19:00:00,");
    expect(csv).toContain("2026-09-09,23:00:00,");
  });

  it("stats totals are unchanged for a zone where no row crosses midnight, and move when one does", async () => {
    const { db } = await setup();
    const sept = { from: "2026-09-01", to: "2026-09-30" };
    const spend = async () => (await rangeOverview(db, user, sept, { today: "2026-10-15" })).currencies.map((c) => [c.currency, c.spendingMinor, c.transactionCount]);
    expect(await spend()).toEqual([["CNY", 1500, 2]]);
    // Beijing 08:00 to 15:00 is 01:00 to 08:00 in London (BST): every row keeps its day.
    await setTimeZone(db, user, "Europe/London");
    expect(await spend()).toEqual([["CNY", 1500, 2]]);
    expect(await rangeTotalsForList(db, user, "2026-09-01", "2026-09-30")).toEqual([{ currency: "CNY", count: 2, spendingMinor: 1500 }]);
    await setTimeZone(db, user, "America/Chicago");
    expect(await spend()).toEqual([["CNY", 2000, 3]]);
    const year = (await rangeOverview(db, user, { from: "2026-09-01", to: "2026-10-31" }, { today: "2026-11-15" })).currencies[0]!;
    expect(year.monthly?.map((m) => [m.month, m.spendingMinor])).toEqual([
      ["2026-09", 2000],
      ["2026-10", 0],
    ]);
  });
});

describe("writes set occurred_on in the user's zone", () => {
  const alipayRow = (occurredAt: string): NormalizedRow => ({
    source: "alipay",
    lineNo: 1,
    externalId: "x1",
    occurredAt,
    amountMinor: -1000,
    currency: "CNY",
    originalAmountMinor: null,
    originalCurrency: null,
    direction: "out",
    kind: "expense",
    status: "ok",
    counterparty: "某商户",
    description: "",
    sourceCategory: null,
    paymentMethod: null,
    raw: {},
  });

  it("import, SMS and manual entry", async () => {
    const db = await freshDb();
    await setTimeZone(db, user, "America/Chicago");
    const parsed: ParseResult = { source: "alipay", rows: [alipayRow("2026-09-18T08:30:00+08:00")], declared: {}, warnings: [] };
    await commitParsed(db, user, parsed, { fileHash: "h", fileName: "f.csv", backup: false });
    const imported = (await db.select().from(transactions).where(eq(transactions.source, "alipay")).limit(1))[0]!;
    expect(imported.occurredOn).toBe("2026-09-17");

    const sms = await createSmsEntry(db, user, { text: "您尾号3141信用卡9月18日08:24POS支出(消费BUSY BEE BOBA Houston)15.74美元。【工商银行】", today: "2026-09-18" });
    expect(await dayOf(db, sms.transactionId)).toBe("2026-09-17");

    const manual = await createQuickEntry(db, user, {
      amountMinor: 1200,
      currency: "USD",
      description: "lunch",
      date: "2026-09-18",
      participantIds: [],
      payerId: null,
      mode: "equal",
      categoryHint: null,
    });
    expect(await dayOf(db, manual.transactionId)).toBe("2026-09-18");
  });
});
