import type { InvestFlow, NetWorthPart, NetWorthParts, NetWorthPoint } from "@yomi/core";
import { describe, expect, it } from "vitest";
import { allSeries, chartDays, flowMarkers, investPartial, investSeries, missingNames, netCashSeries, netDepositsSeries } from "./chart-series";

const parts = (p: Partial<NetWorthParts>): NetWorthParts => {
  const x = { cashMinor: 0, cardsMinor: 0, holdingsMinor: 0, pnlMinor: 0, ...p };
  return { ...x, totalMinor: x.cashMinor + x.cardsMinor + x.holdingsMinor };
};
const KIND = { Checking: "cash", Card: "card", Brokerage: "investment", Alipay: "cash" } as const;
const point = (date: string, usd: Partial<NetWorthParts> | null, known: NetWorthPart[], missing: (keyof typeof KIND)[] = []): NetWorthPoint => ({
  date,
  byCurrency: usd ? { USD: parts(usd) } : {},
  converted: null,
  known: usd ? { USD: known } : {},
  missing: missing.map((name) => ({ name, kind: KIND[name], currencies: ["USD"] })),
});

// Fictional ledger: checking known from day 2, the card from day 3, the brokerage (a daily NAV, no P/L) from day 2
// and with positions from day 4.
const series: NetWorthPoint[] = [
  point("2026-09-01", null, [], ["Checking", "Card", "Brokerage"]),
  point("2026-09-02", { cashMinor: 50000, holdingsMinor: 100000 }, ["cash", "holdings"], ["Card"]),
  point("2026-09-03", { cashMinor: 50000, cardsMinor: -2000, holdingsMinor: 99300 }, ["cash", "cards", "holdings"]),
  point("2026-09-04", { cashMinor: 48000, cardsMinor: -2500, holdingsMinor: 99600, pnlMinor: 600 }, ["cash", "cards", "holdings", "pnl"]),
];

describe("series assembly", () => {
  const days = chartDays({ series, converted: null }, "USD");

  it("starts each line on its own first known day and never fills unknown days with zero", () => {
    const s = allSeries(days);
    expect(s.netWorth).toEqual([null, 150000, 147300, 145100]);
    expect(s.cash).toEqual([null, 50000, 50000, 48000]);
    expect(s.cards).toEqual([null, null, -2000, -2500]);
    expect(s.investments).toEqual([null, 100000, 99300, 99600]);
    expect(netCashSeries(days)).toEqual([null, 50000, 48000, 45500]);
    expect(investSeries(days, "pnl")).toEqual([null, null, null, 600]);
  });

  it("marks net worth partial while an account known later has no value, naming it", () => {
    const s = allSeries(days);
    // Day 1 has no net worth at all, so it is not "partial"; day 2 lacks the card.
    expect(s.partial).toEqual([false, true, false, false]);
    expect(missingNames(days)[1]).toEqual(["Card"]);
    expect(missingNames(days, "investment")).toEqual([["Brokerage"], [], [], []]);
  });

  it("marks investment values partial only while a brokerage account known later is missing", () => {
    expect(investPartial(days, investSeries(days, "value"))).toEqual([false, false, false, false]);
    const later = [point("2026-09-01", { holdingsMinor: 100 }, ["holdings"], ["Brokerage"]), point("2026-09-02", { holdingsMinor: 300 }, ["holdings"])];
    const d = chartDays({ series: later, converted: null }, "USD");
    expect(investPartial(d, investSeries(d, "value"))).toEqual([true, false]);
  });

  it("filters missing accounts by the chart currency, and takes every one when converted", () => {
    const multi: NetWorthPoint[] = [
      {
        ...point("2026-09-02", { cashMinor: 1 }, ["cash"]),
        missing: [
          { name: "Alipay", kind: "cash", currencies: ["CNY"] },
          { name: "Card", kind: "card", currencies: ["USD"] },
        ],
      },
    ];
    expect(missingNames(chartDays({ series: multi, converted: null }, "USD"))[0]).toEqual(["Card"]);
    const converted = [{ ...multi[0]!, converted: parts({ cashMinor: 1 }) }];
    expect(missingNames(chartDays({ series: converted, converted: {} as never }, "USD"))[0]).toEqual(["Alipay", "Card"]);
  });

  it("converted P/L is known only when every currency with holdings knows it", () => {
    const p: NetWorthPoint = {
      date: "2026-09-04",
      byCurrency: { USD: parts({ holdingsMinor: 1 }), HKD: parts({ holdingsMinor: 1 }) },
      converted: parts({ holdingsMinor: 2, pnlMinor: 5 }),
      known: { USD: ["holdings"], HKD: ["holdings", "pnl"] },
      missing: [],
    };
    expect(investSeries(chartDays({ series: [p], converted: {} as never }, "USD"), "pnl")).toEqual([null]);
    const q = { ...p, known: { USD: ["holdings", "pnl"] as NetWorthPart[], HKD: ["holdings", "pnl"] as NetWorthPart[] } };
    expect(investSeries(chartDays({ series: [q], converted: {} as never }, "USD"), "pnl")).toEqual([5]);
  });
});

const flow = (date: string, type: InvestFlow["type"], amountMinor: number, extra: Partial<InvestFlow> = {}): InvestFlow => ({
  date,
  type,
  symbol: type === "transfer" ? null : "VTI",
  amountMinor,
  currency: "USD",
  accountName: "Brokerage",
  convertedMinor: null,
  ...extra,
});

describe("net deposits", () => {
  const dates = ["2026-09-01", "2026-09-02", "2026-09-03", "2026-09-04", "2026-09-05"];
  const values = [null, 100000, 99300, 199600, 194000];

  it("anchors at the first known value and moves only with deposits and withdrawals after it", () => {
    const flows = [
      flow("2026-09-02", "transfer", 30000), // on the anchor day: already in the value
      flow("2026-09-03", "buy", -50000),
      flow("2026-09-04", "transfer", 100000),
      flow("2026-09-04", "dividend", 250),
      flow("2026-09-05", "transfer", -5000),
    ];
    const d = netDepositsSeries(dates, values, flows, "USD", false)!;
    expect(d.from).toBe("2026-09-02");
    expect(d.values).toEqual([null, 100000, 100000, 200000, 195000]);
    // The gap on the last day is the market result since the anchor: 194000 − 195000.
    expect(values[4]! - d.values[4]!).toBe(-1000);
  });

  it("anchors on the first day the value is complete, so an account appearing later is not read as a gain", () => {
    const d = netDepositsSeries(dates, values, [flow("2026-09-04", "transfer", 100000)], "USD", false, [false, true, false, false, false])!;
    expect(d.from).toBe("2026-09-03");
    expect(d.values).toEqual([null, null, 99300, 199300, 199300]);
  });

  it("uses converted amounts when the chart is converted, and gives up on a currency it cannot state", () => {
    const hkd = flow("2026-09-04", "transfer", 78000, { currency: "HKD", convertedMinor: 10000 });
    expect(netDepositsSeries(dates, values, [hkd], "USD", true)!.values).toEqual([null, 100000, 100000, 110000, 110000]);
    expect(netDepositsSeries(dates, values, [hkd], "USD", false)).toBeNull();
    expect(netDepositsSeries(dates, [null, null, null, null, null], [], "USD", false)).toBeNull();
  });

  it("marks trades and dividends on days the value line has a value", () => {
    const m = flowMarkers(dates, values, [flow("2026-09-01", "buy", -1), flow("2026-09-03", "buy", -50000), flow("2026-09-03", "dividend", 250), flow("2026-09-04", "transfer", 100000)]);
    expect(m).toEqual([
      {
        index: 2,
        items: [
          { type: "buy", symbol: "VTI", amountMinor: -50000, currency: "USD" },
          { type: "dividend", symbol: "VTI", amountMinor: 250, currency: "USD" },
        ],
      },
    ]);
  });
});
