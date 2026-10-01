import { readFileSync } from "node:fs";
import { accountBalanceSnapshots, accounts, type Db, jobs } from "@yomi/db";
import { type InvestStatement, type NormalizedRow, parseIcbcItems, type TextItem } from "@yomi/importers";
import { and, asc, eq } from "@yomi/db/orm";
import { describe, expect, it } from "vitest";
import { commitParsed, revertBatch } from "../import/pipeline";
import { writeStatement } from "../invest/store";
import { addTx, freshDb, user } from "../ledger/test-helpers";
import type { ProviderAccount } from "../sync/provider";
import {
  backfillStatementBalances,
  balancesOn,
  balanceTimeline,
  parseSnapshotRaw,
  providerBalanceMinor,
  setStartingBalance,
  statementBalances,
  upsertBalanceSnapshot,
  writeDailyBalanceSnapshots,
} from "./balances";
import { netWorth, netWorthChange, netWorthData } from "./net-worth";

async function addAccount(db: Db, a: Partial<typeof accounts.$inferInsert> & { name: string }): Promise<number> {
  return (await db
    .insert(accounts)
    .values({ userId: user.id, kind: "wallet", currency: "CNY", ...a })
    .returning())[0]!.id;
}

const snaps = async (db: Db, accountId: number) =>
  await db
    .select()
    .from(accountBalanceSnapshots)
    .where(eq(accountBalanceSnapshots.accountId, accountId))
    .orderBy(asc(accountBalanceSnapshots.asOf));

const plaidAccount = (over: Partial<ProviderAccount>): ProviderAccount => ({
  providerAccountId: "a1",
  institutionName: "Bank",
  name: "Checking",
  type: "depository",
  subtype: "checking",
  lastFour: "5501",
  currency: "USD",
  ledgerKind: "debit_card",
  balances: { current: "1019.14", available: "1000", limit: null },
  ...over,
});

describe("Plaid balances mapping", () => {
  it("depository is current (else available); credit and loan are owed, so negative; investment and missing are skipped", () => {
    expect(providerBalanceMinor(plaidAccount({}))).toEqual({ balanceMinor: 101914, currency: "USD" });
    expect(providerBalanceMinor(plaidAccount({ balances: { current: null, available: "12.5", limit: null } }))).toEqual({ balanceMinor: 1250, currency: "USD" });
    expect(providerBalanceMinor(plaidAccount({ type: "credit", ledgerKind: "credit_card", balances: { current: "183.24", available: "4816.76", limit: "5000" } }))).toEqual({
      balanceMinor: -18324,
      currency: "USD",
    });
    expect(providerBalanceMinor(plaidAccount({ type: "credit", balances: { current: null, available: "4816.76", limit: "5000" } }))).toBeNull();
    expect(providerBalanceMinor(plaidAccount({ type: "loan", balances: { current: "900", available: null, limit: null } }))!.balanceMinor).toBe(-90000);
    expect(providerBalanceMinor(plaidAccount({ type: "investment" }))).toBeNull();
    expect(providerBalanceMinor(plaidAccount({ balances: undefined }))).toBeNull();
    expect(providerBalanceMinor(plaidAccount({ currency: "JPY", balances: { current: "1200", available: null, limit: null } }))!.balanceMinor).toBe(1200);
  });
});

describe("ICBC statement balance", () => {
  const pages = JSON.parse(readFileSync(new URL("../../../importers/test/fixtures/icbc/items.json", import.meta.url), "utf8")) as TextItem[][];

  it("takes 账户余额 of the last row per currency, dated the statement's end", () => {
    const parsed = parseIcbcItems(pages);
    const out = statementBalances(
      parsed.rows.map((row) => ({ key: "card", row })),
      parsed.periodEnd,
    );
    expect(out).toEqual([
      { key: "card", currency: "USD", asOf: "2025-08-20", balanceMinor: -128456, lineNo: 14 },
      { key: "card", currency: "HKD", asOf: "2025-08-20", balanceMinor: -125456, lineNo: 3 },
    ]);
  });

  it("uses the row's day when the period ends earlier, the later line on a tie, and skips unreadable balances", () => {
    const row = (lineNo: number, occurredAt: string, balance: string): NormalizedRow => ({
      source: "icbc_pdf",
      lineNo,
      externalId: null,
      occurredAt,
      amountMinor: -100,
      currency: "USD",
      originalAmountMinor: null,
      originalCurrency: null,
      direction: "out",
      kind: "expense",
      status: "ok",
      counterparty: "X",
      description: "消费",
      sourceCategory: null,
      paymentMethod: "工商银行信用卡(3141)",
      raw: { 账户余额: balance },
    });
    const items = [
      { key: "k", row: row(1, "2026-09-20T10:00:00+08:00", "-10.00") },
      { key: "k", row: row(2, "2026-09-20T10:00:00+08:00", "-20.00") },
      { key: "k", row: row(3, "2026-09-21T10:00:00+08:00", "") },
    ];
    expect(statementBalances(items, "2026-09-01")).toEqual([{ key: "k", currency: "USD", asOf: "2026-09-20", balanceMinor: -2000, lineNo: 2 }]);
  });

  it("an ICBC import writes the statement balance per card; reverting the batch removes it", async () => {
    const db = await freshDb();
    const parsed = parseIcbcItems(pages);
    const r = await commitParsed(db, user, parsed, { fileHash: "h1", fileName: "icbc.pdf", backup: false });
    const card = (await db.select().from(accounts).where(eq(accounts.kind, "credit_card")).limit(1))[0]!;
    const rows = (await snaps(db, card.id)).sort((a, b) => a.currency.localeCompare(b.currency));
    expect(rows.map((s) => [s.asOf, s.currency, s.balanceMinor, s.source])).toEqual([
      ["2025-08-20", "HKD", -125456, "statement"],
      ["2025-08-20", "USD", -128456, "statement"],
    ]);
    expect(parseSnapshotRaw(rows[0]!.raw).batchId).toBe(r.batchId);
    await revertBatch(db, user, r.batchId, { backup: false });
    expect(await snaps(db, card.id)).toEqual([]);
  });

  it("backfills the statement balance of an ICBC import made before balances were kept", async () => {
    const db = await freshDb();
    const r = await commitParsed(db, user, parseIcbcItems(pages), { fileHash: "h2", fileName: "icbc.pdf", backup: false });
    const card = (await db.select().from(accounts).where(eq(accounts.kind, "credit_card")).limit(1))[0]!;
    await db.delete(accountBalanceSnapshots);
    expect(await backfillStatementBalances(db, user)).toBe(2);
    expect(await backfillStatementBalances(db, user)).toBe(0);
    const rows = (await snaps(db, card.id)).sort((a, b) => a.currency.localeCompare(b.currency));
    // No stored statement end: dated the last row's day of each currency.
    expect(rows.map((s) => [s.asOf, s.currency, s.balanceMinor, parseSnapshotRaw(s.raw).batchId])).toEqual([
      ["2025-02-19", "HKD", -125456, r.batchId],
      ["2025-03-03", "USD", -128456, r.batchId],
    ]);
  });
});

describe("derived balances (starting balance + transactions)", () => {
  it("adds transactions after the start day per currency, skipping duplicates and closed rows", async () => {
    const db = await freshDb();
    const wallet = await addAccount(db, { name: "支付宝余额", institution: "支付宝" });
    await setStartingBalance(db, user, wallet, { amountMinor: 100000, on: "2026-09-01" });
    await addTx(db, { accountId: wallet, amountMinor: -5000, occurredAt: "2026-09-01T09:00:00+08:00" }); // the start day: already in the balance
    await addTx(db, { accountId: wallet, amountMinor: -2000, occurredAt: "2026-09-03T09:00:00+08:00" });
    await addTx(db, { accountId: wallet, amountMinor: 30000, occurredAt: "2026-09-05T09:00:00+08:00" });
    await addTx(db, { accountId: wallet, amountMinor: -1000, currency: "USD", occurredAt: "2026-09-05T10:00:00+08:00" });
    await addTx(db, { accountId: wallet, amountMinor: -777, status: "closed", occurredAt: "2026-09-06T09:00:00+08:00" });
    const primary = await addTx(db, { amountMinor: -999, occurredAt: "2026-09-06T09:00:00+08:00" });
    await addTx(db, { accountId: wallet, amountMinor: -999, duplicateOfId: primary, occurredAt: "2026-09-06T09:00:00+08:00" });

    const t = await balanceTimeline(db, user, { from: "2026-08-31", to: "2026-09-06" });
    const a = t.accounts.find((x) => x.account.id === wallet)!;
    expect(a.daily.get("CNY")).toEqual([null, 100000, 100000, 98000, 98000, 128000, 128000]);
    expect(a.daily.get("USD")).toEqual([null, null, null, null, null, -1000, -1000]);
    expect(a.sourceAt.get("CNY")).toEqual({ source: "derived", asOf: "2026-09-01" });

    // A range that starts after the start day still counts the transactions before it.
    expect((await balancesOn(db, user, "2026-09-10")).filter((b) => b.account.id === wallet).map((b) => [b.currency, b.balanceMinor])).toEqual([
      ["CNY", 128000],
      ["USD", -1000],
    ]);
  });

  it("setting the starting balance again replaces its manual snapshot; clearing removes it", async () => {
    const db = await freshDb();
    const wallet = await addAccount(db, { name: "微信零钱", institution: "微信" });
    await setStartingBalance(db, user, wallet, { amountMinor: 5000, on: "2026-09-01" });
    expect((await snaps(db, wallet)).map((s) => [s.asOf, s.balanceMinor, s.source])).toEqual([["2026-09-01", 5000, "manual"]]);
    const a = await setStartingBalance(db, user, wallet, { amountMinor: 6100, on: "2026-09-10" });
    expect([a.startingBalanceMinor, a.startingBalanceOn]).toEqual([6100, "2026-09-10"]);
    expect((await snaps(db, wallet)).map((s) => [s.asOf, s.balanceMinor, s.source])).toEqual([["2026-09-10", 6100, "manual"]]);
    await setStartingBalance(db, user, wallet, null);
    expect(await snaps(db, wallet)).toEqual([]);
    await expect(setStartingBalance(db, user, wallet, { amountMinor: 1, on: "2026-13-01" })).rejects.toThrow(expect.objectContaining({ code: "assets_invalid_date" }));
    await expect(setStartingBalance(db, user, 999, { amountMinor: 1, on: "2026-09-01" })).rejects.toThrow(expect.objectContaining({ code: "assets_account_not_found" }));
  });
});

describe("daily snapshot step", () => {
  it("writes derived balances and carried copies once a day; a real balance later replaces the copies after it", async () => {
    const db = await freshDb();
    const wallet = await addAccount(db, { name: "支付宝余额", institution: "支付宝" });
    const card = await addAccount(db, { name: "工商银行信用卡 3141", kind: "credit_card", institution: "工商银行", last4: "3141", currency: "USD" });
    await setStartingBalance(db, user, wallet, { amountMinor: 10000, on: "2026-09-01" });
    await addTx(db, { accountId: wallet, amountMinor: -2500, occurredAt: "2026-09-02T09:00:00+08:00" });
    await upsertBalanceSnapshot(db, user, { accountId: card, asOf: "2026-09-24", balanceMinor: -18324, currency: "USD", source: "statement" });

    const day = (d: string) => () => new Date(`${d}T04:00:00Z`); // noon in Shanghai
    expect(await writeDailyBalanceSnapshots(db, user, { now: day("2026-09-28") })).toBe(2);
    expect(await writeDailyBalanceSnapshots(db, user, { now: day("2026-09-28") })).toBeNull();
    expect((await db.select().from(jobs).where(and(eq(jobs.name, "balance-snapshots"))).limit(1))[0]!.cursor).toBe("2026-09-28");
    expect(await writeDailyBalanceSnapshots(db, user, { now: day("2026-09-29") })).toBe(2);

    expect((await snaps(db, wallet)).map((s) => [s.asOf, s.balanceMinor, s.source])).toEqual([
      ["2026-09-01", 10000, "manual"],
      ["2026-09-28", 7500, "derived"],
      ["2026-09-29", 7500, "derived"],
    ]);
    const cardRows = await snaps(db, card);
    expect(cardRows.map((s) => [s.asOf, s.balanceMinor, s.source, parseSnapshotRaw(s.raw).carriedFrom ?? null])).toEqual([
      ["2026-09-24", -18324, "statement", null],
      ["2026-09-28", -18324, "statement", "2026-09-24"],
      ["2026-09-29", -18324, "statement", "2026-09-24"],
    ]);
    // The account row still reports the statement's own day.
    const v = (await netWorthData(db, user, { asOf: "2026-09-29", range: "1m" })).accounts.find((a) => a.id === card)!;
    expect(v.balances).toEqual([{ currency: "USD", balanceMinor: -18324, changeMinor: null, source: "statement", sourceAsOf: "2026-09-24" }]);

    // An older statement (Sep 20) leaves the copies of the newer Sep 24 balance alone.
    await upsertBalanceSnapshot(db, user, { accountId: card, asOf: "2026-09-20", balanceMinor: -9000, currency: "USD", source: "statement" });
    expect(await snaps(db, card)).toHaveLength(4);
    await db.delete(accountBalanceSnapshots).where(and(eq(accountBalanceSnapshots.accountId, card), eq(accountBalanceSnapshots.asOf, "2026-09-20")));
    // A statement dated the 28th: the copy after it repeated an older balance and goes.
    await upsertBalanceSnapshot(db, user, { accountId: card, asOf: "2026-09-28", balanceMinor: -5000, currency: "USD", source: "statement" });
    expect((await snaps(db, card)).map((s) => [s.asOf, s.balanceMinor])).toEqual([
      ["2026-09-24", -18324],
      ["2026-09-28", -5000],
    ]);
  });
});

const holding = (security: string | null, currency: string, marketValue: string, costBasis: string | null) => ({
  accountExternalId: "U3141",
  securityExternalId: security,
  currency,
  quantity: "1",
  price: marketValue,
  marketValue,
  costBasis,
  raw: {},
});
const ibkr = (asOf: string, vti: string): InvestStatement => ({
  source: "ibkr",
  asOf,
  accounts: [{ externalId: "U3141", name: "IBKR U3141", currency: "USD" }],
  securities: [{ externalId: "1", symbol: "VTI", name: "VTI", type: "STK", currency: "USD", isin: null, cusip: null, multiplier: null }],
  holdings: [holding("1", "USD", vti, "250"), holding(null, "USD", "10", null)],
  transactions: [],
  warnings: [],
});

async function ledger() {
  const db = await freshDb();
  const checking = await addAccount(db, { name: "Checking", kind: "debit_card", institution: "Bank", last4: "5501", currency: "USD" });
  const card = await addAccount(db, { name: "Card", kind: "credit_card", institution: "Bank", last4: "3141", currency: "USD" });
  const wallet = await addAccount(db, { name: "支付宝余额", institution: "支付宝" });
  await addAccount(db, { name: "Untracked", kind: "debit_card", institution: "Other", currency: "CNY" });
  await upsertBalanceSnapshot(db, user, { accountId: checking, asOf: "2026-08-20", balanceMinor: 100000, currency: "USD", source: "plaid" });
  await upsertBalanceSnapshot(db, user, { accountId: checking, asOf: "2026-09-25", balanceMinor: 131240, currency: "USD", source: "plaid" });
  await upsertBalanceSnapshot(db, user, { accountId: card, asOf: "2026-09-24", balanceMinor: -18324, currency: "USD", source: "statement" });
  await setStartingBalance(db, user, wallet, { amountMinor: 71000, on: "2026-09-01" });
  await addTx(db, { accountId: wallet, amountMinor: -1000, occurredAt: "2026-09-10T09:00:00+08:00" });
  await writeStatement(db, user, ibkr("2026-09-25", "300"));
  await writeStatement(db, user, ibkr("2026-09-28", "310"));
  return { db, checking, card, wallet };
}

const fxFetch = (async () =>
  new Response(JSON.stringify([{ date: "2026-09-29", base: "USD", quote: "CNY", rate: 7.1 }]))) as unknown as typeof fetch;

describe("net worth", () => {
  it("per currency: cash, cards (negative), holdings; 30-day change only when the earlier day is known", async () => {
    const { db } = await ledger();
    const n = await netWorthData(db, user, { asOf: "2026-09-29", range: "1m" });
    expect(n.currencies).toEqual([
      { currency: "CNY", cashMinor: 70000, cardsMinor: 0, holdingsMinor: 0, pnlMinor: 0, totalMinor: 70000, changeMinor: null },
      // VTI 310 − cost 250 = 60 P/L; brokerage cash 10.
      { currency: "USD", cashMinor: 131240, cardsMinor: -18324, holdingsMinor: 32000, pnlMinor: 6000, totalMinor: 144916, changeMinor: 144916 - 100000 },
    ]);
    expect(n.hasBalances).toBe(true);
    expect(n.accounts.find((a) => a.name === "Untracked")!.balances).toEqual([]);
  });

  it("history carries gaps forward day by day", async () => {
    const { db } = await ledger();
    const n = await netWorthData(db, user, { asOf: "2026-09-29", range: "1m" });
    expect(n.from).toBe("2026-08-30");
    expect(n.series).toHaveLength(31);
    const at = (d: string) => n.series.find((p) => p.date === d)!.byCurrency;
    expect(at("2026-08-30").USD!.totalMinor).toBe(100000);
    expect(at("2026-09-24").USD).toMatchObject({ cashMinor: 100000, cardsMinor: -18324, holdingsMinor: 0 });
    expect(at("2026-09-26").USD).toMatchObject({ cashMinor: 131240, cardsMinor: -18324, holdingsMinor: 31000 });
    expect(at("2026-09-27").USD!.holdingsMinor).toBe(31000);
    expect(at("2026-09-29").USD!.holdingsMinor).toBe(32000);
    expect(at("2026-08-30").CNY).toBeUndefined();
    expect(at("2026-09-09").CNY!.totalMinor).toBe(71000);
    expect(at("2026-09-10").CNY!.totalMinor).toBe(70000);
  });

  it("ranges: 1M, 3M, 1Y go back 30, 90, 365 days; All starts at the first known day", async () => {
    const { db } = await ledger();
    const from = async (range: "1m" | "3m" | "1y" | "all") => (await netWorthData(db, user, { asOf: "2026-09-29", range })).from;
    expect([await from("1m"), await from("3m"), await from("1y"), await from("all")]).toEqual(["2026-08-30", "2026-07-01", "2025-09-29", "2026-08-20"]);
    expect((await netWorthData(db, user, { asOf: "2026-09-29", range: "3m" })).series).toHaveLength(91);
  });

  it("converts with the stated Frankfurter rate and date, never summing currencies without it", async () => {
    const { db } = await ledger();
    const now = () => new Date("2026-09-29T20:00:00Z");
    const n = await netWorth(db, user, { asOf: "2026-09-29", range: "1m", currency: "USD" }, { fetch: fxFetch, now });
    // ¥700.00 at 7.1 per USD = $98.59 (half away from zero).
    expect(n.converted).toMatchObject({ currency: "USD", totalMinor: 144916 + 9859, cashMinor: 131240 + 9859, cardsMinor: -18324, holdingsMinor: 32000, changeMinor: 44916 });
    expect(n.converted!.fx).toEqual({ source: "frankfurter", date: "2026-09-29", rates: [{ from: "CNY", rate: "0.140845", inverse: "7.1" }] });
    expect(n.series.at(-1)!.converted!.totalMinor).toBe(144916 + 9859);
    expect(n.series[0]!.converted!.totalMinor).toBe(100000);
    expect(n.fxError).toBeNull();

    const offline = (async () => {
      throw new Error("offline");
    }) as unknown as typeof fetch;
    const db2 = (await ledger()).db;
    const m = await netWorth(db2, user, { asOf: "2026-09-29", currency: "USD" }, { fetch: offline, now });
    expect(m.converted).toBeNull();
    expect(m.fxError).toMatchObject({ code: "invest_fx_unavailable" });
    expect(m.currencies.map((c) => c.currency)).toEqual(["CNY", "USD"]);
    expect(m.series[0]!.converted).toBeNull();
  });

  it("change over a period for Stats", async () => {
    const { db } = await ledger();
    const c = await netWorthChange(db, user, { from: "2026-09-01", to: "2026-09-30" });
    // USD: Aug 31 = 100000, Sep 30 = 144916; CNY: nothing on Aug 31, 70000 on Sep 30.
    expect(c!.currencies).toEqual([
      { currency: "CNY", changeMinor: 70000 },
      { currency: "USD", changeMinor: 44916 },
    ]);
    expect(await netWorthChange(await freshDb(), user, { from: "2026-09-01", to: "2026-09-30" })).toBeNull();
  });
});
