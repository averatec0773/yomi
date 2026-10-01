import { readFileSync } from "node:fs";
import { bankAccounts, bankConnections, type Db, holdingSnapshots, investmentAccounts, investmentTransactions, jobs, plaidLinkSessions, securities } from "@yomi/db";
import { createPlaidClient, type InvestStatement, mapFlexStatement } from "@yomi/importers";
import { eq } from "@yomi/db/orm";
import { describe, expect, it } from "vitest";
import { freshDb, user } from "../ledger/test-helpers";
import { createPlaidProvider } from "../sync/plaid";
import { BankSyncError, connectWithPublicToken, createLinkToken, syncAll, syncConnection } from "../sync/sync";
import { InvestError } from "./errors";
import { convertMinor, crossRate, FX_JOB, type FxTable, getFxRates } from "./fx";
import { toInvestError } from "./ibkr";
import { holdingsDue, HOLDINGS_SYNC_JOB, ibkrDue, parseHoldingsState, runHoldingsSyncJob } from "./job";
import { convertOverview, portfolioOverview } from "./overview";
import { ibkrErrorCode, ibkrStatus } from "./status";
import { latestSnapshotDate, writeStatement } from "./store";
import { syncHoldings } from "./sync";
import { lastCompletedTradingDay, marketClock, retryWindowClosed } from "./time";

const flexXml = readFileSync(new URL("../../../importers/test/fixtures/ibkr/flex-activity.xml", import.meta.url), "utf8");
const flex = () => mapFlexStatement(flexXml);

/** The fixture with its date moved and one position changed, like the next day's statement. */
function nextDay(asOf: string, patch: (s: InvestStatement) => void = () => {}): InvestStatement {
  const s = structuredClone(flex());
  s.asOf = asOf;
  patch(s);
  return s;
}

const count = async (db: Db, t: typeof holdingSnapshots | typeof investmentTransactions | typeof securities | typeof investmentAccounts) =>
  (await db.select().from(t)).length;

describe("writeStatement", () => {
  it("stores minor units from decimal strings and is idempotent for the same day", async () => {
    const db = await freshDb();
    const r = await writeStatement(db, user, flex());
    expect([r.accounts, r.positions, r.cashBalances, r.transactionsNew]).toEqual([1, 4, 2, 5]);
    // USD: 2384.7957 + 690 − 62.5 + 4102.335 = 7114.6307 → 238480 + 69000 − 6250 + 410234
    expect(r.totals).toEqual({ USD: 238480 + 69000 - 6250 + 410234, HKD: 4202000 + 885010 });
    const aapl = (await db.select().from(holdingSnapshots).where(eq(holdingSnapshots.positionKey, "sec:1")).limit(1))[0]!;
    expect([aapl.quantity, aapl.price, aapl.marketValueMinor, aapl.costBasisMinor, aapl.asOf]).toEqual(["10.5", "227.1234", 238480, 200012, "2026-09-28"]);

    const again = await writeStatement(db, user, flex());
    expect([again.transactionsNew, again.transactionsUpdated]).toEqual([0, 5]);
    expect([await count(db, holdingSnapshots), await count(db, investmentTransactions), await count(db, securities), await count(db, investmentAccounts)]).toEqual([6, 5, 4, 1]);
  });

  it("overwrites that day's snapshot: a position sold since the first run disappears", async () => {
    const db = await freshDb();
    await writeStatement(db, user, flex());
    await writeStatement(
      db,
      user,
      nextDay("2026-09-28", (s) => {
        s.holdings = s.holdings.filter((h) => h.securityExternalId !== "37196556");
      }),
    );
    expect(await count(db, holdingSnapshots)).toBe(5);
    await writeStatement(db, user, nextDay("2026-09-29"));
    expect(await count(db, holdingSnapshots)).toBe(11);
    expect(await latestSnapshotDate(db, user, "ibkr")).toBe("2026-09-29");
    expect(await latestSnapshotDate(db, user, "plaid")).toBeNull();
  });
});

describe("portfolioOverview", () => {
  it("totals per account and currency, P/L over positions with a cost, change vs the previous snapshot", async () => {
    const db = await freshDb();
    await writeStatement(db, user, flex());
    await writeStatement(
      db,
      user,
      nextDay("2026-09-29", (s) => {
        const aapl = s.holdings.find((h) => h.securityExternalId === "265598")!;
        aapl.price = "230";
        aapl.marketValue = "2415"; // 10.5 × 230
        s.holdings = s.holdings.filter((h) => h.securityExternalId !== "1111");
      }),
    );
    const o = await portfolioOverview(db, user);
    expect(o.asOf).toBe("2026-09-29");
    const a = o.accounts[0]!;
    expect([a.asOf, a.previousAsOf, a.provider, a.name]).toEqual(["2026-09-29", "2026-09-28", "ibkr", "Test IBKR"]);
    expect(a.syncedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    const usd = a.totals.find((t) => t.currency === "USD")!;
    // market: 241500 + 69000 + 410234 ; cost: 200012 + 102000 ; P/L: 41488 − 33000
    expect(usd).toEqual({
      currency: "USD",
      marketValueMinor: 241500 + 69000 + 410234,
      costBasisMinor: 200012 + 102000,
      unrealizedPnlMinor: 241500 - 200012 + (69000 - 102000),
      previousMarketValueMinor: 238480 + 69000 - 6250 + 410234,
      changeMinor: 241500 + 69000 + 410234 - (238480 + 69000 - 6250 + 410234),
    });
    const aapl = a.positions.find((p) => p.symbol === "AAPL")!;
    expect([aapl.previousMarketValueMinor, aapl.changeMinor, aapl.unrealizedPnlMinor]).toEqual([238480, 3020, 41488]);
    const cash = a.positions.find((p) => p.positionKey === "cash:HKD")!;
    expect([cash.type, cash.symbol, cash.costBasisMinor, cash.unrealizedPnlMinor, cash.changeMinor]).toEqual(["cash", "HKD", null, null, 0]);
    expect(o.totals.map((t) => t.currency)).toEqual(["HKD", "USD"]);

    // As of the first day: no previous snapshot, so no change.
    const first = await portfolioOverview(db, user, { asOf: "2026-09-28" });
    expect(first.accounts[0]!.previousAsOf).toBeNull();
    expect(first.totals.every((t) => t.changeMinor === null)).toBe(true);
    // The short position: P/L −62.5 − (−70) = +7.5
    expect(first.accounts[0]!.positions.find((p) => p.symbol === "XYZ")!.unrealizedPnlMinor).toBe(750);
    expect((await portfolioOverview(db, user, { asOf: "2026-01-01" })).accounts[0]!).toMatchObject({ asOf: null, syncedAt: null });
  });

  it("converts per-currency totals once each and shows the rate and its date", async () => {
    const db = await freshDb();
    await writeStatement(db, user, flex());
    const fx: FxTable = { base: "USD", date: "2026-09-28", rates: { CNY: "6.7034", HKD: "7.846" }, source: "frankfurter" };
    const o = await portfolioOverview(db, user);
    const c = convertOverview(o, "CNY", fx);
    const usd = o.totals.find((t) => t.currency === "USD")!.marketValueMinor;
    const hkd = o.totals.find((t) => t.currency === "HKD")!.marketValueMinor;
    expect(c.marketValueMinor).toBe(convertMinor(usd, "USD", "CNY", fx) + convertMinor(hkd, "HKD", "CNY", fx));
    expect(c.fx).toEqual({ source: "frankfurter", base: "USD", date: "2026-09-28", rates: [{ from: "HKD", rate: "0.854372" }, { from: "USD", rate: "6.7034" }] });
  });
});

describe("FX", () => {
  const fx: FxTable = { base: "USD", date: "2026-09-29", rates: { CNY: "6.7034", HKD: "7.846", JPY: "157.12" }, source: "frankfurter" };

  it("converts with integer math and one rounding step", () => {
    expect(convertMinor(10000, "USD", "CNY", fx)).toBe(67034);
    // 100.00 HKD → CNY: 10000 × 6.7034 / 7.846 = 8543.72... → 8544
    expect(convertMinor(10000, "HKD", "CNY", fx)).toBe(8544);
    expect(convertMinor(-10000, "HKD", "CNY", fx)).toBe(-8544);
    // JPY has no minor digits: 1.00 USD → 157 JPY; 157 JPY → 1.00 USD
    expect(convertMinor(100, "USD", "JPY", fx)).toBe(157);
    expect(convertMinor(157, "JPY", "USD", fx)).toBe(100);
    expect(convertMinor(123, "CNY", "CNY", fx)).toBe(123);
    expect(crossRate("HKD", "CNY", fx)).toBe("0.854372");
    expect(() => convertMinor(1, "EUR", "USD", fx)).toThrow(InvestError);
  });

  it("fetches Frankfurter v2 once per New York day and falls back to the cache when it fails", async () => {
    const db = await freshDb();
    const urls: string[] = [];
    let down = false;
    const f = (async (u: string | URL | Request) => {
      urls.push(String(u));
      if (down) throw new Error("offline");
      return new Response(
        JSON.stringify([
          { date: "2026-09-29", base: "USD", quote: "CNY", rate: 6.7036 },
          { date: "2026-09-29", base: "USD", quote: "HKD", rate: 7.8509 },
        ]),
      );
    }) as typeof fetch;
    const now = () => new Date("2026-09-29T20:00:00Z");
    const t = await getFxRates(db, user, ["hkd", "CNY", "USD"], { fetch: f, now });
    expect(t).toEqual({ base: "USD", date: "2026-09-29", rates: { CNY: "6.7036", HKD: "7.8509" }, source: "frankfurter" });
    expect(new URL(urls[0]!).toString()).toBe("https://api.frankfurter.dev/v2/rates?base=USD&quotes=CNY%2CHKD");
    await getFxRates(db, user, ["CNY"], { fetch: f, now });
    expect(urls.length).toBe(1);
    down = true;
    const tomorrow = () => new Date("2026-09-30T20:00:00Z");
    expect((await getFxRates(db, user, ["HKD"], { fetch: f, now: tomorrow })).date).toBe("2026-09-29");
    expect(urls.length).toBe(2);
    await expect(getFxRates(db, user, ["EUR"], { fetch: f, now: tomorrow })).rejects.toMatchObject({ code: "invest_fx_unavailable" });
    expect((await db.select().from(jobs).where(eq(jobs.name, FX_JOB)).limit(1))[0]?.cursor).toContain('"fetchedOn":"2026-09-29"');
  });
});

describe("holdings-sync schedule", () => {
  // EDT is UTC−4: 18:00 New York = 22:00Z, 06:00 New York = 10:00Z. 2026-09-29 is a Tuesday.
  const ny = (date: string, hhmm: string) => {
    const [h, m] = hhmm.split(":").map(Number) as [number, number];
    return new Date(Date.parse(`${date}T00:00:00Z`) + ((h + 4) * 60 + m) * 60_000);
  };

  it("targets the last weekday whose 18:00 New York close has passed", () => {
    // 2026-09-28 is a Monday.
    expect(marketClock(new Date("2026-09-28T22:30:00Z"))).toEqual({ date: "2026-09-28", hour: 18, weekday: 1 });
    expect(lastCompletedTradingDay(new Date("2026-09-28T22:30:00Z"))).toBe("2026-09-28");
    expect(lastCompletedTradingDay(new Date("2026-09-28T21:59:00Z"))).toBe("2026-09-25");
    expect(lastCompletedTradingDay(new Date("2026-09-27T15:00:00Z"))).toBe("2026-09-25");
    expect(lastCompletedTradingDay(new Date("2026-09-29T05:00:00Z"))).toBe("2026-09-28");
    expect(ny("2026-09-29", "18:00").toISOString()).toBe("2026-09-29T22:00:00.000Z");
  });

  it("closes the retry window at 06:00 New York the morning after", () => {
    expect(retryWindowClosed("2026-09-29", ny("2026-09-29", "23:00"))).toBe(false);
    expect(retryWindowClosed("2026-09-29", ny("2026-09-30", "05:59"))).toBe(false);
    expect(retryWindowClosed("2026-09-29", ny("2026-09-30", "06:00"))).toBe(true);
    expect(retryWindowClosed("2026-10-02", ny("2026-10-05", "10:00"))).toBe(true);
  });

  it("is due after close, catches up when the latest snapshot is older, and stops once the expected day arrived", () => {
    const afterClose = new Date("2026-09-28T23:00:00Z");
    const beforeClose = new Date("2026-09-28T15:00:00Z");
    const ctx = { ibkrConfigured: true, plaidConnections: true, latestIbkrSnapshot: "2026-09-25" };
    expect(holdingsDue({}, afterClose, ctx)).toEqual(["ibkr", "plaid"]);
    expect(holdingsDue({}, beforeClose, ctx)).toEqual(["plaid"]);
    expect(holdingsDue({}, beforeClose, { ...ctx, latestIbkrSnapshot: "2026-09-18" })).toEqual(["ibkr", "plaid"]);
    const done = {
      ibkr: { expected: "2026-09-28", received: "2026-09-28", attempts: 0, lastAttemptAt: "2026-09-28T22:10:00Z", at: "2026-09-28T22:10:00Z" },
      plaid: { target: "2026-09-28", at: "x" },
    };
    expect(holdingsDue(done, afterClose, ctx)).toEqual([]);
    expect(holdingsDue({}, afterClose, { ibkrConfigured: false, plaidConnections: false, latestIbkrSnapshot: null })).toEqual([]);
  });

  it("retries a stale statement every 2 hours until 06:00 New York, never within 10 minutes", () => {
    const stale = (attempts: number, last: Date) => ({ expected: "2026-09-29", received: "2026-09-28", attempts, lastAttemptAt: last.toISOString(), at: last.toISOString() });
    const first = ny("2026-09-29", "18:30");
    // Received vs expected: the cursor holds what arrived, so the expected day is still asked for.
    expect(ibkrDue(stale(1, first), ny("2026-09-29", "20:00"), "2026-09-28")).toBe(false);
    expect(ibkrDue(stale(1, first), ny("2026-09-29", "20:30"), "2026-09-28")).toBe(true);
    expect(ibkrDue({ ...stale(0, first), received: "2026-09-29" }, ny("2026-09-29", "23:00"), "2026-09-29")).toBe(false);
    // A manual sync that already stored the expected day also ends the retries.
    expect(ibkrDue(stale(1, first), ny("2026-09-29", "21:00"), "2026-09-29")).toBe(false);

    // Around 06:00 the next morning.
    expect(ibkrDue(stale(2, ny("2026-09-30", "04:30")), ny("2026-09-30", "05:59"), "2026-09-28")).toBe(false);
    expect(ibkrDue(stale(2, ny("2026-09-30", "03:30")), ny("2026-09-30", "05:59"), "2026-09-28")).toBe(true);
    expect(ibkrDue(stale(2, ny("2026-09-30", "03:30")), ny("2026-09-30", "06:00"), "2026-09-28")).toBe(false);
    expect(ibkrDue(stale(2, ny("2026-09-30", "03:30")), ny("2026-09-30", "14:00"), "2026-09-28")).toBe(false);
    // Back to the daily cadence: the next evening expects the next day.
    expect(ibkrDue(stale(2, ny("2026-09-30", "03:30")), ny("2026-09-30", "18:00"), "2026-09-28")).toBe(true);

    // Rate limit spacing: even the first pull for a new day (or after a failure) waits 10 minutes.
    const failed = stale(0, ny("2026-09-29", "18:05"));
    expect(ibkrDue(failed, ny("2026-09-29", "18:14"), "2026-09-28")).toBe(false);
    expect(ibkrDue(failed, ny("2026-09-29", "18:15"), "2026-09-28")).toBe(true);
    const yesterday = { expected: "2026-09-28", received: "2026-09-28", attempts: 0, lastAttemptAt: ny("2026-09-29", "17:55").toISOString(), at: null };
    expect(ibkrDue(yesterday, ny("2026-09-29", "18:00"), "2026-09-28")).toBe(false);
    expect(ibkrDue(yesterday, ny("2026-09-29", "18:05"), "2026-09-28")).toBe(true);
  });

  it("retries through the night, picks up a statement published at 01:30, and treats 06:00 still stale as a holiday", () => {
    const stale = (attempts: number, last: string, lastDay = "2026-09-29") => ({
      expected: "2026-09-29",
      received: "2026-09-28",
      attempts,
      lastAttemptAt: ny(lastDay, last).toISOString(),
      at: null,
    });
    // Many stale answers do not stop the retries before 06:00.
    expect(ibkrDue(stale(4, "00:00", "2026-09-30"), ny("2026-09-30", "02:00"), "2026-09-28")).toBe(true);
    expect(ibkrDue(stale(5, "04:00", "2026-09-30"), ny("2026-09-30", "05:59"), "2026-09-28")).toBe(false);
    // At 06:00 still stale: holiday / not published, wait for the next expected day.
    expect(ibkrDue(stale(5, "04:00", "2026-09-30"), ny("2026-09-30", "06:00"), "2026-09-28")).toBe(false);
    expect(ibkrDue(stale(5, "04:00", "2026-09-30"), ny("2026-09-30", "17:59"), "2026-09-28")).toBe(false);
    expect(ibkrDue(stale(5, "04:00", "2026-09-30"), ny("2026-09-30", "18:00"), "2026-09-28")).toBe(true);
  });

  it("expects the last weekday on weekends", () => {
    // Saturday and Sunday: Friday 2026-10-02 is expected; once it is in, nothing is due all weekend.
    expect(lastCompletedTradingDay(ny("2026-10-03", "12:00"))).toBe("2026-10-02");
    expect(lastCompletedTradingDay(ny("2026-10-04", "20:00"))).toBe("2026-10-02");
    const friday = { expected: "2026-10-02", received: "2026-10-02", attempts: 0, lastAttemptAt: ny("2026-10-02", "18:00").toISOString(), at: null };
    expect(ibkrDue(friday, ny("2026-10-03", "12:00"), "2026-10-02")).toBe(false);
    expect(ibkrDue(friday, ny("2026-10-05", "17:59"), "2026-10-02")).toBe(false);
    expect(ibkrDue(friday, ny("2026-10-05", "18:00"), "2026-10-02")).toBe(true);
    // App off since Thursday: catch up on Saturday.
    expect(ibkrDue(undefined, ny("2026-10-03", "12:00"), "2026-10-01")).toBe(true);
  });

  it("records the statement date received, retries until the expected day arrives, backs off on failure", async () => {
    const db = await freshDb();
    let calls = 0;
    let failWith: unknown = null;
    let serves = "2026-09-28";
    const ibkr = {
      fetchStatement: async () => {
        calls++;
        if (failWith) throw failWith;
        return nextDay(serves);
      },
    };
    let now = ny("2026-09-29", "21:00");
    const clock = () => now;
    const cursor = async () => parseHoldingsState((await db.select().from(jobs).where(eq(jobs.name, HOLDINGS_SYNC_JOB)).limit(1))[0]!.cursor).ibkr;

    // The observed case: at 21:00 IBKR still serves Monday's statement.
    const r1 = await runHoldingsSyncJob(db, user, { ibkr, plaid: null, now: clock });
    expect(r1).toMatchObject({ ran: true, expected: "2026-09-29", providers: ["ibkr"] });
    expect(r1.ran && r1.result.results[0]).toMatchObject({ asOf: "2026-09-28", expectedAsOf: "2026-09-29", stale: true });
    expect(await cursor()).toMatchObject({ expected: "2026-09-29", received: "2026-09-28", attempts: 1, lastAttemptAt: now.toISOString() });
    now = ny("2026-09-29", "21:10");
    expect(await runHoldingsSyncJob(db, user, { ibkr, plaid: null, now: clock })).toEqual({ ran: false, reason: "not_due" });
    now = ny("2026-09-29", "23:00");
    await runHoldingsSyncJob(db, user, { ibkr, plaid: null, now: clock });
    expect(await cursor()).toMatchObject({ received: "2026-09-28", attempts: 2 });
    serves = "2026-09-29";
    now = ny("2026-09-30", "01:00");
    const r3 = await runHoldingsSyncJob(db, user, { ibkr, plaid: null, now: clock });
    expect(r3.ran && r3.result.results[0]!.stale).toBe(false);
    expect(await cursor()).toMatchObject({ expected: "2026-09-29", received: "2026-09-29", attempts: 0 });
    now = ny("2026-09-30", "03:30");
    expect(await runHoldingsSyncJob(db, user, { ibkr, plaid: null, now: clock })).toEqual({ ran: false, reason: "not_due" });
    expect(calls).toBe(3);

    now = ny("2026-09-30", "18:30");
    failWith = toInvestError(new (await import("@yomi/importers")).FlexError("token_expired", "1012", "Token has expired."));
    const r4 = await runHoldingsSyncJob(db, user, { ibkr, plaid: null, now: clock });
    expect(r4.ran && r4.result.errors.map((e) => e.code)).toEqual(["invest_ibkr_token_expired"]);
    const job = (await db.select().from(jobs).where(eq(jobs.name, HOLDINGS_SYNC_JOB)).limit(1))[0]!;
    expect([job.status, job.lastError]).toEqual(["failed", "ibkr: invest_ibkr_token_expired"]);
    expect(await cursor()).toMatchObject({ expected: "2026-09-30", received: "2026-09-29", attempts: 0 });
    expect(await runHoldingsSyncJob(db, user, { ibkr, plaid: null, now: clock })).toEqual({ ran: false, reason: "backoff" });

    // A holiday: IBKR keeps serving the day before all night; after 06:00 it waits for the next day.
    failWith = null;
    const night = [
      ["2026-09-30", "19:01"],
      ["2026-09-30", "20:00"],
      ["2026-09-30", "21:02"],
      ["2026-09-30", "23:03"],
      ["2026-10-01", "01:04"],
      ["2026-10-01", "03:05"],
      ["2026-10-01", "05:06"],
      ["2026-10-01", "06:00"],
      ["2026-10-01", "08:00"],
      ["2026-10-01", "17:50"],
    ] as const;
    for (const [day, hhmm] of night) {
      now = ny(day, hhmm);
      await runHoldingsSyncJob(db, user, { ibkr, plaid: null, now: clock });
    }
    expect(calls).toBe(4 + 6);
    expect(await cursor()).toMatchObject({ expected: "2026-09-30", received: "2026-09-29", attempts: 6 });
    serves = "2026-10-01";
    now = ny("2026-10-01", "18:00");
    await runHoldingsSyncJob(db, user, { ibkr, plaid: null, now: clock });
    expect(await cursor()).toMatchObject({ expected: "2026-10-01", received: "2026-10-01", attempts: 0 });
  });

  it("keeps asking every 2 hours from 18:00 and picks up a statement published at 01:30 at the 02:00 attempt", async () => {
    const db = await freshDb();
    const pulls: string[] = [];
    let now = ny("2026-09-29", "18:00");
    const ibkr = {
      fetchStatement: async () => {
        pulls.push(now.toISOString());
        return nextDay(now >= ny("2026-09-30", "01:30") ? "2026-09-29" : "2026-09-28");
      },
    };
    // The scheduler ticks every 10 minutes from 18:00 to 06:00.
    for (let t = ny("2026-09-29", "18:00").getTime(); t <= ny("2026-09-30", "06:00").getTime(); t += 10 * 60_000) {
      now = new Date(t);
      await runHoldingsSyncJob(db, user, { ibkr, plaid: null, now: () => now });
    }
    expect(pulls).toEqual(["18:00", "20:00", "22:00", "00:00", "02:00"].map((h, i) => ny(i < 3 ? "2026-09-29" : "2026-09-30", h).toISOString()));
    expect(await latestSnapshotDate(db, user, "ibkr")).toBe("2026-09-29");
    const state = parseHoldingsState((await db.select().from(jobs).where(eq(jobs.name, HOLDINGS_SYNC_JOB)).limit(1))[0]!.cursor).ibkr;
    expect(state).toMatchObject({ expected: "2026-09-29", received: "2026-09-29", attempts: 0 });
  });

  it("drops a pre-fix IBKR cursor that recorded the target instead of the day received", async () => {
    const db = await freshDb();
    await writeStatement(db, user, nextDay("2026-09-28"));
    await db.insert(jobs)
      .values({ userId: user.id, name: HOLDINGS_SYNC_JOB, status: "idle", cursor: JSON.stringify({ ibkr: { target: "2026-09-29", at: "2026-09-30T01:00:00Z" } }) });
    expect(parseHoldingsState((await db.select().from(jobs).limit(1))[0]!.cursor)).toEqual({});
    const ibkr = { fetchStatement: async () => nextDay("2026-09-29") };
    const r = await runHoldingsSyncJob(db, user, { ibkr, plaid: null, now: () => ny("2026-09-29", "22:00") });
    expect(r).toMatchObject({ ran: true, expected: "2026-09-29" });
    expect(await latestSnapshotDate(db, user, "ibkr")).toBe("2026-09-29");
  });
});

// ---- Plaid brokerage connections -------------------------------------------------------------

function fakePlaidInvest() {
  const calls: { path: string; body: Record<string, unknown> }[] = [];
  const f = (async (url: string | URL | Request, init?: RequestInit) => {
    const path = new URL(String(url)).pathname;
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    calls.push({ path, body });
    const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status });
    const account = { account_id: "inv_1", name: "Brokerage", mask: "1234", type: "investment", subtype: "brokerage", balances: { iso_currency_code: "USD" } };
    const secs = [
      { security_id: "s_vti", ticker_symbol: "VTI", name: "Vanguard Total Stock Market ETF", type: "etf", iso_currency_code: "USD" },
      { security_id: "s_usd", ticker_symbol: "CUR:USD", name: "US Dollar", type: "cash", is_cash_equivalent: true, iso_currency_code: "USD" },
    ];
    switch (path) {
      case "/link/token/create":
        return json({ link_token: "link-sandbox-inv", expiration: "2026-09-29T04:00:00Z", request_id: "r" });
      case "/item/public_token/exchange":
        return json({ access_token: "access-sandbox-inv", item_id: "item_inv", request_id: "r" });
      case "/investments/holdings/get":
        return json({
          accounts: [account],
          securities: secs,
          holdings: [
            { account_id: "inv_1", security_id: "s_vti", institution_price: 301.4567, institution_value: 1025.26, cost_basis: 900.5, quantity: 3.40111, iso_currency_code: "USD" },
            { account_id: "inv_1", security_id: "s_usd", institution_price: 1, institution_value: 55.1, cost_basis: 55.1, quantity: 55.1, iso_currency_code: "USD" },
          ],
          item: { item_id: "item_inv", institution_name: "Robinhood" },
          request_id: "r",
        });
      case "/investments/transactions/get":
        return json({
          accounts: [account],
          securities: secs,
          investment_transactions: [
            { investment_transaction_id: "it1", account_id: "inv_1", security_id: "s_vti", date: "2026-09-01", quantity: 0.40111, amount: 120.12, price: 299.47, type: "buy", subtype: "buy", iso_currency_code: "USD" },
          ],
          total_investment_transactions: 1,
          item: { item_id: "item_inv" },
          request_id: "r",
        });
    }
    return json({ error_type: "INVALID_REQUEST", error_code: "NOT_FOUND", error_message: path, display_message: null }, 400);
  }) as typeof fetch;
  const provider = createPlaidProvider({ sandbox: createPlaidClient({ clientId: "cid", secret: "sec", environment: "sandbox", fetch: f }) });
  return { calls, provider };
}

describe("Plaid brokerage connections", () => {
  it("links with the investments product, keeps no ledger accounts and never runs transactions sync", async () => {
    const db = await freshDb();
    const p = fakePlaidInvest();
    const link = await createLinkToken(db, user, p.provider, { kind: "brokerage" });
    expect(p.calls[0]!.body.products).toEqual(["investments"]);
    expect((await db.select().from(plaidLinkSessions).limit(1))[0]!.kind).toBe("brokerage");

    // The browser does not say what the login is for: the Link session decides.
    const conn = await connectWithPublicToken(db, user, p.provider, { publicToken: "public-sandbox-inv", institutionName: "Robinhood", linkSessionId: link.sessionId });
    expect(conn.kind).toBe("brokerage");
    expect(await db.select().from(bankAccounts)).toEqual([]);
    expect(p.calls.map((c) => c.path)).toEqual(["/link/token/create", "/item/public_token/exchange"]);

    await expect(syncConnection(db, user, p.provider, conn.id)).rejects.toMatchObject({ code: "bank_connection_is_brokerage", kind: "connection_is_brokerage" });
    await expect(syncConnection(db, user, p.provider, conn.id)).rejects.toBeInstanceOf(BankSyncError);
    expect(await syncAll(db, user, p.provider)).toEqual({ results: [], errors: [] });
    expect(p.calls.some((c) => c.path === "/transactions/sync")).toBe(false);

    const now = () => new Date("2026-09-29T23:00:00Z");
    const r = await syncHoldings(db, user, { provider: "plaid" }, { plaid: p.provider, now });
    expect(r.errors).toEqual([]);
    expect(r.results[0]).toMatchObject({ provider: "plaid", connectionId: conn.id, stale: false, expectedAsOf: null, asOf: "2026-09-29", positions: 1, cashBalances: 1, transactionsNew: 1, totals: { USD: 102526 + 5510 } });
    const txBody = p.calls.find((c) => c.path === "/investments/transactions/get")!.body;
    expect([txBody.start_date, txBody.end_date]).toEqual(["2024-09-29", "2026-09-29"]);
    const vti = (await db.select().from(holdingSnapshots).where(eq(holdingSnapshots.positionKey, "sec:1")).limit(1))[0]!;
    expect([vti.quantity, vti.price, vti.marketValueMinor, vti.costBasisMinor]).toEqual(["3.40111", "301.4567", 102526, 90050]);
    expect((await db.select().from(investmentTransactions).limit(1))[0]!.amountMinor).toBe(-12012);
    const stored = (await db.select().from(bankConnections).where(eq(bankConnections.id, conn.id)).limit(1))[0]!;
    expect([stored.cursor, stored.status]).toEqual(["2026-09-29", "active"]);
    expect((await db.select().from(investmentAccounts).limit(1))[0]).toMatchObject({ provider: "plaid", bankConnectionId: conn.id, name: "Robinhood Brokerage 1234" });

    // Same day again: overwritten, not duplicated; the next pull starts 30 days before the cursor.
    await syncHoldings(db, user, { provider: "plaid" }, { plaid: p.provider, now });
    expect(await count(db, holdingSnapshots)).toBe(2);
    expect(p.calls.filter((c) => c.path === "/investments/transactions/get").at(-1)!.body.start_date).toBe("2026-08-30");
  });

  it("requires a configured provider when named, skips it under all", async () => {
    const db = await freshDb();
    await expect(syncHoldings(db, user, { provider: "ibkr" }, {})).rejects.toMatchObject({ code: "invest_ibkr_not_configured" });
    await expect(syncHoldings(db, user, { provider: "plaid" }, {})).rejects.toMatchObject({ code: "invest_plaid_not_configured" });
    expect(await syncHoldings(db, user, { provider: "all" }, {})).toEqual({ results: [], errors: [], skipped: ["ibkr", "plaid"] });
  });
});

describe("ibkrStatus", () => {
  // 2026-09-28 is a Monday; EDT is UTC−4.
  const at = (date: string, hhmm: string) => new Date(`${date}T${hhmm}:00-04:00`);
  const env = { IBKR_FLEX_TOKEN: "flex-token-value", IBKR_FLEX_QUERY_ID: "flex-query-value" };

  it("reads the latest statement, its positions and the state; never the token", async () => {
    const db = await freshDb();
    expect(await ibkrStatus(db, user, {}, at("2026-09-29", "12:00"))).toMatchObject({
      configured: false,
      missing: ["IBKR_FLEX_TOKEN", "IBKR_FLEX_QUERY_ID"],
      state: "not_configured",
      lastStatementDate: null,
      positions: 0,
    });
    expect((await ibkrStatus(db, user, env, at("2026-09-29", "12:00"))).state).toBe("never");

    const w = await writeStatement(db, user, nextDay("2026-09-28"));
    const monday = await ibkrStatus(db, user, env, at("2026-09-29", "12:00"));
    expect(monday).toMatchObject({ state: "active", lastStatementDate: "2026-09-28", positions: w.positions, expectedAsOf: "2026-09-28", errorCode: null });
    expect(w.positions).toBeGreaterThan(0);
    expect(monday.syncedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(JSON.stringify(monday)).not.toContain("flex-token-value");
    expect(JSON.stringify(monday)).not.toContain("flex-query-value");
    // After Tuesday's close the Monday statement is behind.
    expect(await ibkrStatus(db, user, env, at("2026-09-29", "19:00"))).toMatchObject({ state: "waiting", expectedAsOf: "2026-09-29" });
    // Not configured wins, but what was stored stays visible.
    expect(await ibkrStatus(db, user, {}, at("2026-09-29", "12:00"))).toMatchObject({ state: "not_configured", lastStatementDate: "2026-09-28" });
  });

  it("reports the failed scheduled pull until a statement is stored after it", async () => {
    const db = await freshDb();
    await writeStatement(db, user, nextDay("2026-09-28"));
    const fail = async (lastAttemptAt: string, lastError = "ibkr: invest_ibkr_token_expired; plaid #2: bank_provider_auth") => {
      const cursor = JSON.stringify({ ibkr: { expected: "2026-09-28", received: null, attempts: 0, lastAttemptAt, at: null } });
      await db.insert(jobs)
        .values({ userId: user.id, name: HOLDINGS_SYNC_JOB, status: "failed", lastError, cursor })
        .onConflictDoUpdate({ target: [jobs.userId, jobs.name], set: { status: "failed", lastError, cursor } });
    };
    await fail("2999-01-01T00:00:00.000Z");
    expect(await ibkrStatus(db, user, env, at("2026-09-29", "12:00"))).toMatchObject({ state: "error", errorCode: "invest_ibkr_token_expired" });
    // A manual sync stored a statement after that attempt.
    await fail("2000-01-01T00:00:00.000Z");
    expect(await ibkrStatus(db, user, env, at("2026-09-29", "12:00"))).toMatchObject({ state: "active", errorCode: null });
    // Only Plaid failed.
    await fail("2999-01-01T00:00:00.000Z", "plaid #2: bank_provider_auth");
    expect((await ibkrStatus(db, user, env, at("2026-09-29", "12:00"))).state).toBe("active");
  });

  it("finds the IBKR code in a job error", () => {
    expect(ibkrErrorCode(null)).toBeNull();
    expect(ibkrErrorCode("plaid #3: invest_plaid_error; ibkr: invest_ibkr_rate_limited")).toBe("invest_ibkr_rate_limited");
    expect(ibkrErrorCode("plaid: invest_plaid_error")).toBeNull();
  });
});
