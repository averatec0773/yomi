// Plaid Investments responses → normalized holdings, cash and transactions (see README.md).
import type { InvestAccountRow, InvestHoldingRow, InvestSecurityRow, InvestStatement, InvestTxnKind, InvestTxnRow } from "../invest";
import { type Notice, notice } from "../errors";
import { numberToDecimal } from "../util/decimal";
import type { PlaidHolding, PlaidInvestmentsHoldingsResponse, PlaidInvestmentTransaction, PlaidSecurity } from "./types";

const CASH_TICKER = /^(?:CUR:)?([A-Z]{3})$/;

/**
 * A holding is a cash balance when its security is type `cash` with a currency ticker: `USD` in the
 * docs sample, `CUR:USD` at some institutions. Money market funds are also type `cash` but carry a
 * fund ticker (e.g. SPAXX) and stay securities.
 */
export function plaidCashCurrency(s: PlaidSecurity | undefined): string | null {
  if (!s || s.type !== "cash") return null;
  const m = CASH_TICKER.exec((s.ticker_symbol ?? "").trim().toUpperCase());
  return m ? m[1]! : null;
}

function currencyOf(x: { iso_currency_code?: string | null; unofficial_currency_code?: string | null } | undefined, fallback = "USD"): string {
  return (x?.iso_currency_code ?? x?.unofficial_currency_code ?? fallback).toUpperCase();
}

function plaidSecurityRow(s: PlaidSecurity): InvestSecurityRow {
  return {
    externalId: s.security_id,
    symbol: s.ticker_symbol ?? null,
    name: s.name ?? null,
    type: s.type ?? null,
    currency: currencyOf(s),
    isin: s.isin ?? null,
    cusip: s.cusip ?? null,
    // Plaid's institution_value already includes the contract size; the multiplier is not reported.
    multiplier: null,
  };
}

/** Plaid investment transaction type/subtype → yomi kind. */
export function plaidInvestKind(t: Pick<PlaidInvestmentTransaction, "type" | "subtype">): InvestTxnKind {
  const sub = (t.subtype ?? "").toLowerCase();
  switch (t.type) {
    case "buy":
      return "buy";
    case "sell":
      return "sell";
    case "fee":
      return "fee";
    case "transfer":
      return "transfer";
    case "cash":
      if (sub.includes("dividend")) return "dividend";
      if (sub.includes("interest")) return "interest";
      if (sub.includes("tax") || sub.includes("fee")) return "fee";
      if (["deposit", "withdrawal", "contribution", "distribution", "transfer", "send", "request"].includes(sub)) return "transfer";
      return "other";
    default:
      return "other";
  }
}

function negate(n: number): string {
  return numberToDecimal(n === 0 ? 0 : -n);
}

/**
 * Maps /investments/holdings/get (and optionally the pages of /investments/transactions/get) to a
 * statement dated `asOf`. Quantities and prices keep the double's shortest decimal text; fractional
 * shares stay exact as sent. Cash holdings (type cash, currency ticker) become cash rows. Transaction
 * `amount` is negated so that positive means cash into the account.
 */
export function plaidInvestmentsToStatement(
  holdingsResp: Pick<PlaidInvestmentsHoldingsResponse, "accounts" | "holdings" | "securities">,
  txns: { transactions: PlaidInvestmentTransaction[]; securities: PlaidSecurity[] } | null,
  opts: { asOf: string; institutionName?: string | null },
): InvestStatement {
  const warnings: Notice[] = [];
  const secById = new Map<string, PlaidSecurity>();
  for (const s of [...holdingsResp.securities, ...(txns?.securities ?? [])]) secById.set(s.security_id, s);
  const used = new Map<string, InvestSecurityRow>();
  const useSecurity = (id: string | null | undefined): string | null => {
    if (!id) return null;
    const s = secById.get(id);
    if (!s) return null;
    if (!used.has(id)) used.set(id, plaidSecurityRow(s));
    return id;
  };

  const withHoldings = new Set(holdingsResp.holdings.map((h) => h.account_id));
  const accounts: InvestAccountRow[] = holdingsResp.accounts
    .filter((a) => a.type === "investment" || a.type === "brokerage" || withHoldings.has(a.account_id))
    .map((a) => ({
      externalId: a.account_id,
      name: [opts.institutionName, a.official_name || a.name, a.mask].filter(Boolean).join(" "),
      currency: currencyOf(a.balances ?? undefined),
    }));
  const known = new Set(accounts.map((a) => a.externalId));

  const holdings: InvestHoldingRow[] = [];
  for (const h of holdingsResp.holdings) {
    if (!known.has(h.account_id)) continue;
    const s = secById.get(h.security_id);
    const cash = plaidCashCurrency(s);
    const raw = h as unknown as Record<string, unknown>;
    if (cash) {
      holdings.push({
        accountExternalId: h.account_id,
        securityExternalId: null,
        currency: currencyOf(h, cash),
        quantity: numberToDecimal(h.quantity),
        price: numberToDecimal(h.institution_price),
        marketValue: numberToDecimal(h.institution_value),
        costBasis: null,
        raw,
      });
      continue;
    }
    if (!s) warnings.push(notice("invest_security_unknown", `Holding with unknown security ${h.security_id} kept without details`, { securityId: h.security_id }));
    const secId = useSecurity(h.security_id) ?? h.security_id;
    if (!used.has(secId)) used.set(secId, { ...plaidSecurityRow({ security_id: secId }), currency: currencyOf(h) });
    holdings.push(holdingRow(h, secId));
  }

  const transactions: InvestTxnRow[] = [];
  for (const t of txns?.transactions ?? []) {
    if (!known.has(t.account_id)) continue;
    const cash = plaidCashCurrency(t.security_id ? secById.get(t.security_id) : undefined);
    transactions.push({
      accountExternalId: t.account_id,
      securityExternalId: cash ? null : useSecurity(t.security_id),
      externalId: t.investment_transaction_id,
      date: t.date,
      type: plaidInvestKind(t),
      quantity: t.quantity ? numberToDecimal(t.quantity) : null,
      amount: negate(t.amount),
      currency: currencyOf(t),
      description: t.name ?? null,
      raw: t as unknown as Record<string, unknown>,
    });
  }

  return { source: "plaid", asOf: opts.asOf, accounts, securities: [...used.values()], holdings, transactions, warnings };
}

function holdingRow(h: PlaidHolding, securityExternalId: string): InvestHoldingRow {
  return {
    accountExternalId: h.account_id,
    securityExternalId,
    currency: currencyOf(h),
    quantity: numberToDecimal(h.quantity),
    price: numberToDecimal(h.institution_price),
    marketValue: numberToDecimal(h.institution_value),
    costBasis: h.cost_basis == null ? null : numberToDecimal(h.cost_basis),
    raw: h as unknown as Record<string, unknown>,
  };
}
