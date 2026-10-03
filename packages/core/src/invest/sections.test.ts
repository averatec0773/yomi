import { readFileSync } from "node:fs";
import { type FlexRange, type InvestStatement, mapFlexStatement } from "@yomi/importers";
import { describe, expect, it } from "vitest";
import { freshDb, user } from "../ledger/test-helpers";
import { writeSetting } from "../settings/store";
import { daysInclusive } from "../time/day";
import { pullIbkrHistory } from "./job";
import {
  IBKR_SECTIONS_SETTING,
  type IbkrPullSections,
  type IbkrSectionsRecord,
  ibkrQueryKey,
  nextSectionsRecord,
  parseSectionsRecord,
  recordIbkrSections,
} from "./sections";
import { ibkrStatus } from "./status";
import { syncHoldings } from "./sync";

const ALL = ["accountInformation", "openPositions", "cashReport", "trades", "cashTransactions", "nav"];
const without = (...ids: string[]) => ALL.filter((id) => !ids.includes(id));
const pull = (from: string, to: string, present: string[], query: string | null = "q1"): IbkrPullSections => ({ at: `${to}T23:00:00.000Z`, from, to, present, query });
const states = (r: IbkrSectionsRecord) => Object.fromEntries(r.sections.map((s) => [s.id, s.state]));
const after = (...pulls: IbkrPullSections[]) => pulls.reduce<IbkrSectionsRecord | null>((r, p) => nextSectionsRecord(r, p), null)!;

describe("IBKR Flex section verdict", () => {
  it("counts both ends of the window", () => {
    expect(daysInclusive("2026-09-29", "2026-09-29")).toBe(1);
    expect(daysInclusive("2026-08-31", "2026-09-29")).toBe(30);
    expect(daysInclusive("2025-09-30", "2026-09-29")).toBe(365);
  });

  it("everything present: present", () => {
    expect(Object.values(states(after(pull("2026-09-29", "2026-09-29", ALL))))).toEqual(Array(6).fill("present"));
  });

  it("a one-day test without trades or cash transactions cannot tell: unknown, not missing", () => {
    expect(states(after(pull("2026-09-29", "2026-09-29", without("trades", "cashTransactions"))))).toMatchObject({ trades: "unknown", cashTransactions: "unknown", nav: "present" });
    // A 29-day window is still too short.
    expect(states(after(pull("2026-09-01", "2026-09-29", without("trades"))))).toMatchObject({ trades: "unknown" });
  });

  it("a window of 30 days or more without them: missing", () => {
    expect(states(after(pull("2026-08-31", "2026-09-29", without("trades", "cashTransactions"))))).toMatchObject({ trades: "missing", cashTransactions: "missing" });
  });

  it("a multi-day pull beats a later one-day test, both ways", () => {
    // Seen over 365 days, then a quiet day: still present.
    expect(states(after(pull("2025-09-30", "2026-09-28", ALL), pull("2026-09-29", "2026-09-29", without("trades", "cashTransactions"))))).toMatchObject({
      trades: "present",
      cashTransactions: "present",
    });
    // Lacking over 365 days, then a quiet day: still missing.
    expect(states(after(pull("2025-09-30", "2026-09-28", without("trades")), pull("2026-09-29", "2026-09-29", without("trades"))))).toMatchObject({ trades: "missing" });
    // Lacking over 365 days, then a day that has it (the query was fixed): present.
    expect(states(after(pull("2025-09-30", "2026-09-28", without("trades")), pull("2026-09-29", "2026-09-29", ALL)))).toMatchObject({ trades: "present" });
  });

  it("the other sections follow the latest pull, whatever its window", () => {
    // NAV added to the query after a 365-day pull without it: the next one-day pull clears the note.
    expect(states(after(pull("2025-09-30", "2026-09-28", without("nav")), pull("2026-09-29", "2026-09-29", ALL))).nav).toBe("present");
    expect(states(after(pull("2025-09-30", "2026-09-28", ALL), pull("2026-09-29", "2026-09-29", without("nav", "accountInformation"))))).toMatchObject({
      nav: "missing",
      accountInformation: "missing",
      openPositions: "present",
    });
  });

  it("another query starts over", () => {
    const r = after(pull("2025-09-30", "2026-09-28", without("trades"), "q1"), pull("2026-09-29", "2026-09-29", without("trades"), "q2"));
    expect([r.query, states(r).trades]).toEqual(["q2", "unknown"]);
  });

  it("reads back only a valid record and fills sections it did not know", () => {
    expect(parseSectionsRecord(null)).toBeNull();
    expect(parseSectionsRecord("not json")).toBeNull();
    expect(parseSectionsRecord(JSON.stringify({ v: 2, sections: [] }))).toBeNull();
    const old = parseSectionsRecord(JSON.stringify({ v: 1, query: "q1", at: "x", from: "2026-09-29", to: "2026-09-29", sections: [{ id: "trades", state: "present" }] }))!;
    expect(states(old)).toEqual({ accountInformation: "unknown", openPositions: "unknown", cashReport: "unknown", trades: "present", cashTransactions: "unknown", nav: "unknown" });
  });

  it("fingerprints the query id without storing it", () => {
    expect(ibkrQueryKey(" 123456 ")).toBe(ibkrQueryKey("123456"));
    expect(ibkrQueryKey("123456")).not.toBe(ibkrQueryKey("123457"));
    expect(ibkrQueryKey("123456")).not.toContain("123456");
  });
});

describe("IBKR Flex sections on the row", () => {
  const env = { IBKR_FLEX_TOKEN: "flex-token-value", IBKR_FLEX_QUERY_ID: "654321" };
  const at = new Date("2026-09-30T12:00:00-04:00");
  const flexXml = readFileSync(new URL("../../../importers/test/fixtures/ibkr/flex-activity.xml", import.meta.url), "utf8");
  const statement = (sections: string[]): InvestStatement => ({ ...mapFlexStatement(flexXml), sections });

  it("every pull records its sections; the status shows them for the current query only", async () => {
    const db = await freshDb();
    expect((await ibkrStatus(db, user, env, at)).sectionCheck).toBeNull();

    const windows: { from: string; to: string }[] = [];
    const source = (sections: string[]) => ({
      queryKey: ibkrQueryKey(env.IBKR_FLEX_QUERY_ID),
      fetchStatement: async (range?: FlexRange) => {
        if (range && "from" in range) windows.push(range);
        return statement(sections);
      },
    });
    // The first sync backfills 365 days with every section but NAV.
    await syncHoldings(db, user, { provider: "ibkr" }, { ibkr: source(without("nav")), now: () => at });
    expect(daysInclusive(windows[0]!.from, windows[0]!.to)).toBe(365);
    expect(states((await ibkrStatus(db, user, env, at)).sectionCheck as IbkrSectionsRecord)).toMatchObject({ trades: "present", nav: "missing" });

    // Sync now on a quiet week (from 7 days before the stored statement): Trades absent proves nothing.
    await syncHoldings(db, user, { provider: "ibkr" }, { ibkr: source(without("trades", "nav")), now: () => at });
    expect(daysInclusive(windows[1]!.from, windows[1]!.to)).toBeLessThan(30);
    const check = (await ibkrStatus(db, user, env, at)).sectionCheck!;
    expect(check).toMatchObject({ from: windows[1]!.from, to: "2026-09-29" });
    expect(states(check as IbkrSectionsRecord)).toMatchObject({ nav: "missing", trades: "present", cashTransactions: "present" });

    // Pull history over 365 days without Trades: now missing.
    await pullIbkrHistory(db, user, { days: 365 }, { ibkr: source(without("trades", "nav")), now: () => at });
    expect(states((await ibkrStatus(db, user, env, at)).sectionCheck as IbkrSectionsRecord)).toMatchObject({ trades: "missing", nav: "missing" });

    // Another query id (env changed): nothing to show until it is pulled.
    expect((await ibkrStatus(db, user, { ...env, IBKR_FLEX_QUERY_ID: "777777" }, at)).sectionCheck).toBeNull();
    // Not configured: nothing.
    expect((await ibkrStatus(db, user, {}, at)).sectionCheck).toBeNull();
  });

  it("a statement without a section list (Plaid-style) records nothing", async () => {
    const db = await freshDb();
    const st = mapFlexStatement(flexXml);
    delete st.sections;
    await syncHoldings(db, user, { provider: "ibkr" }, { ibkr: { fetchStatement: async () => st }, now: () => at });
    expect((await ibkrStatus(db, user, env, at)).sectionCheck).toBeNull();
  });

  it("recordIbkrSections keeps one record per user in user_settings", async () => {
    const db = await freshDb();
    await writeSetting(db, user, IBKR_SECTIONS_SETTING, "garbage");
    const r = await recordIbkrSections(db, user, pull("2026-09-29", "2026-09-29", ALL, ibkrQueryKey("654321")));
    expect(states(r).nav).toBe("present");
    expect((await ibkrStatus(db, user, env, at)).sectionCheck?.sections).toEqual(r.sections);
  });
});
