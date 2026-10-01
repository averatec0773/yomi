import { describe, expect, it } from "vitest";
import { createPlaidClient } from "./client";
import { plaidCashCurrency, plaidInvestKind, plaidInvestmentsToStatement } from "./investments";
import type { PlaidAccount, PlaidHolding, PlaidInvestmentTransaction, PlaidSecurity } from "./types";

// Shapes follow https://plaid.com/docs/api/products/investments/ (docs sample values, synthetic ids).
const acct: PlaidAccount = {
  account_id: "inv_1",
  name: "Plaid IRA",
  official_name: null,
  mask: "5555",
  type: "investment",
  subtype: "ira",
  balances: { iso_currency_code: "USD", unofficial_currency_code: null },
};
const checking: PlaidAccount = { ...acct, account_id: "chk_1", name: "Checking", type: "depository", subtype: "checking" };
const secs: PlaidSecurity[] = [
  { security_id: "sec_cash", ticker_symbol: "USD", name: "U S Dollar", type: "cash", subtype: "cash", is_cash_equivalent: true, iso_currency_code: "USD" },
  { security_id: "sec_curusd", ticker_symbol: "CUR:USD", name: "US Dollar", type: "cash", is_cash_equivalent: true, iso_currency_code: "USD" },
  { security_id: "sec_mmf", ticker_symbol: "SPAXX", name: "Money market", type: "cash", is_cash_equivalent: true, iso_currency_code: "USD" },
  { security_id: "sec_fund", ticker_symbol: "MIPTX", name: "Matthews Pacific Tiger Fund", type: "mutual fund", cusip: "577130834", isin: "US5771308344", iso_currency_code: "USD" },
];
const holding = (security_id: string, quantity: number, price: number, value: number, cost: number | null): PlaidHolding => ({
  account_id: "inv_1",
  security_id,
  institution_price: price,
  institution_price_as_of: "2026-09-28",
  institution_value: value,
  cost_basis: cost,
  quantity,
  iso_currency_code: "USD",
  unofficial_currency_code: null,
});
const txn = (id: string, type: string, subtype: string, amount: number, quantity: number, security_id: string | null): PlaidInvestmentTransaction => ({
  investment_transaction_id: id,
  account_id: "inv_1",
  security_id,
  date: "2026-09-20",
  name: `${type} ${subtype}`,
  quantity,
  amount,
  price: 27.53,
  fees: 0,
  type,
  subtype,
  iso_currency_code: "USD",
  unofficial_currency_code: null,
});

describe("Plaid holdings mapping", () => {
  const st = plaidInvestmentsToStatement(
    {
      accounts: [acct, checking],
      securities: secs,
      holdings: [
        holding("sec_cash", 12.34, 1, 12.34, 12.34),
        holding("sec_mmf", 100.5, 1, 100.5, 100.5),
        holding("sec_fund", 47.74104242992852, 27.5301, 1314.32, 1289.01),
        holding("sec_unknown", 1, 2.11, 2.11, null),
      ],
    },
    {
      securities: [],
      transactions: [
        txn("t1", "sell", "sell", -1289.01, -47.74104242992852, "sec_fund"),
        txn("t2", "cash", "dividend", -7.7, 0, "sec_fund"),
        txn("t3", "buy", "buy", 50, 1.5, "sec_fund"),
        txn("t4", "cash", "deposit", -100, 0, "sec_cash"),
        txn("t5", "fee", "account fee", 5.25, 0, null),
        txn("t6", "cash", "dividend", -1, 0, null),
      ],
    },
    { asOf: "2026-09-29", institutionName: "Vanguard" },
  );

  it("keeps only investment accounts and names them", () => {
    expect(st.accounts).toEqual([{ externalId: "inv_1", name: "Vanguard Plaid IRA 5555", currency: "USD" }]);
    expect(st.asOf).toBe("2026-09-29");
  });

  it("turns currency-ticker cash into cash rows, keeps money market funds as securities", () => {
    const cash = st.holdings.filter((h) => h.securityExternalId == null);
    expect(cash.map((h) => [h.currency, h.quantity, h.marketValue, h.costBasis])).toEqual([["USD", "12.34", "12.34", null]]);
    expect(st.holdings.find((h) => h.securityExternalId === "sec_mmf")?.marketValue).toBe("100.5");
    expect(plaidCashCurrency(secs[1])).toBe("USD");
    expect(plaidCashCurrency(secs[2])).toBeNull();
  });

  it("keeps fractional quantities, prices and total cost basis exact", () => {
    const f = st.holdings.find((h) => h.securityExternalId === "sec_fund")!;
    expect([f.quantity, f.price, f.marketValue, f.costBasis]).toEqual(["47.74104242992852", "27.5301", "1314.32", "1289.01"]);
    expect(st.securities.find((s) => s.externalId === "sec_fund")).toMatchObject({ symbol: "MIPTX", type: "mutual fund", cusip: "577130834" });
    expect(st.holdings.find((h) => h.securityExternalId === "sec_unknown")?.costBasis).toBeNull();
    expect(st.warnings.length).toBe(1);
  });

  it("maps transactions with cash-in positive", () => {
    expect(st.transactions.map((t) => [t.externalId, t.type, t.amount, t.quantity, t.securityExternalId])).toEqual([
      ["t1", "sell", "1289.01", "-47.74104242992852", "sec_fund"],
      ["t2", "dividend", "7.7", null, "sec_fund"],
      ["t3", "buy", "-50", "1.5", "sec_fund"],
      ["t4", "transfer", "100", null, null],
      ["t5", "fee", "-5.25", null, null],
      ["t6", "dividend", "1", null, null],
    ]);
    expect(plaidInvestKind({ type: "cash", subtype: "tax withheld" })).toBe("fee");
    expect(plaidInvestKind({ type: "cancel", subtype: null })).toBe("other");
  });
});

describe("Plaid investments client", () => {
  it("pages /investments/transactions/get with count and offset until the total", async () => {
    const all = Array.from({ length: 5 }, (_, i) => txn(`t${i}`, "buy", "buy", 1, 1, "sec_fund"));
    const bodies: Record<string, unknown>[] = [];
    const f = (async (_u: string | URL | Request, init?: RequestInit) => {
      const b = JSON.parse(String(init?.body)) as { options: { count: number; offset: number } };
      bodies.push(b);
      const page = all.slice(b.options.offset, b.options.offset + b.options.count);
      return new Response(JSON.stringify({ accounts: [acct], securities: secs, investment_transactions: page, total_investment_transactions: all.length, item: { item_id: "i" }, request_id: "r" }));
    }) as typeof fetch;
    const c = createPlaidClient({ clientId: "id", secret: "s", environment: "sandbox", fetch: f });
    const r = await c.investmentsTransactionsGet("access-sandbox-x", "2024-09-29", "2026-09-29", { count: 2 });
    expect(r.transactions.map((t) => t.investment_transaction_id)).toEqual(["t0", "t1", "t2", "t3", "t4"]);
    expect(bodies.map((b) => (b.options as { offset: number }).offset)).toEqual([0, 2, 4]);
    expect(bodies[0]).toMatchObject({ access_token: "access-sandbox-x", start_date: "2024-09-29", end_date: "2026-09-29" });
  });

  it("asks Link for investments only on a brokerage login, transactions otherwise", async () => {
    const bodies: Record<string, unknown>[] = [];
    const f = (async (_u: string | URL | Request, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return new Response(JSON.stringify({ link_token: "link-sandbox-1", expiration: "x" }));
    }) as typeof fetch;
    const c = createPlaidClient({ clientId: "id", secret: "s", environment: "sandbox", fetch: f });
    await c.linkTokenCreate({ clientUserId: "1", clientName: "yomi", products: ["investments"] });
    await c.linkTokenCreate({ clientUserId: "1", clientName: "yomi" });
    expect(bodies[0]!.products).toEqual(["investments"]);
    expect(bodies[0]!.transactions).toBeUndefined();
    expect(bodies[1]!.products).toEqual(["transactions"]);
    expect(bodies[1]!.transactions).toEqual({ days_requested: 730 });
  });
});
