// Activity Flex Query XML → normalized holdings, cash and transactions (see README.md for the shape).
import type { InvestAccountRow, InvestHoldingRow, InvestNavRow, InvestSecurityRow, InvestStatement, InvestTxnKind, InvestTxnRow } from "../invest";
import { type Notice, notice } from "../errors";
import { normalizeDecimal } from "../util/decimal";
import { child, childrenNamed, parseXml, type XmlElement } from "../util/xml";
import { FlexError } from "./client";

/**
 * The Activity Flex Query sections yomi reads, by id, with the XML element each one appears as inside a
 * FlexStatement ("Net Asset Value (NAV) in Base" is EquitySummaryInBase).
 */
export const FLEX_SECTIONS = {
  accountInformation: "AccountInformation",
  openPositions: "OpenPositions",
  cashReport: "CashReport",
  trades: "Trades",
  cashTransactions: "CashTransactions",
  nav: "EquitySummaryInBase",
} as const;
export type FlexSectionId = keyof typeof FLEX_SECTIONS;
export const FLEX_SECTION_IDS = Object.keys(FLEX_SECTIONS) as FlexSectionId[];

/** "2026-09-28", "20260928", "2026-09-28;160000", "20260928;160000" or "09/28/2026" → "2026-09-28". */
export function flexDate(v: string | undefined): string | null {
  const s = (v ?? "").trim();
  let m = /^(\d{4})-?(\d{2})-?(\d{2})/.exec(s);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = /^(\d{2})\/(\d{2})\/(\d{4})/.exec(s);
  if (m) return `${m[3]}-${m[1]}-${m[2]}`;
  return null;
}

function dec(v: string | undefined): string | null {
  const s = (v ?? "").trim();
  if (s === "" || s === "--") return null;
  try {
    return normalizeDecimal(s);
  } catch {
    return null;
  }
}

function str(v: string | undefined): string | null {
  const s = (v ?? "").trim();
  return s === "" ? null : s;
}

/** Summary rows only: a query with lots or executions enabled repeats a position per lot (LOT) or order. */
function isSummary(el: XmlElement, accepted: string[]): boolean {
  const lod = (el.attrs.levelOfDetail ?? "").toUpperCase();
  return lod === "" || accepted.includes(lod);
}

function security(el: XmlElement, warnings: Notice[]): InvestSecurityRow | null {
  const conid = str(el.attrs.conid);
  if (!conid) {
    warnings.push(notice("invest_row_without_conid", `${el.name} row without conid skipped`, { element: el.name }));
    return null;
  }
  const mult = dec(el.attrs.multiplier);
  return {
    externalId: conid,
    symbol: str(el.attrs.symbol),
    name: str(el.attrs.description),
    type: str(el.attrs.assetCategory),
    currency: (str(el.attrs.currency) ?? "USD").toUpperCase(),
    isin: str(el.attrs.isin) ?? (el.attrs.securityIDType === "ISIN" ? str(el.attrs.securityID) : null),
    cusip: str(el.attrs.cusip) ?? (el.attrs.securityIDType === "CUSIP" ? str(el.attrs.securityID) : null),
    multiplier: mult && mult !== "1" ? mult : null,
  };
}

/** CashTransaction `type` values (Flex labels; older statements say "Deposits & Withdrawals"). */
function cashKind(type: string): InvestTxnKind {
  const t = type.toLowerCase();
  if (t.includes("dividend") || t.includes("payment in lieu")) return "dividend";
  if (t.includes("withholding")) return "fee";
  if (t.includes("interest")) return "interest";
  if (t.includes("fee") || t.includes("commission")) return "fee";
  if (t.includes("deposit") || t.includes("withdraw") || t.includes("transfer")) return "transfer";
  return "other";
}

function attrsOf(el: XmlElement): Record<string, unknown> {
  return { element: el.name, ...el.attrs };
}

/**
 * Maps one Flex XML document (FlexQueryResponse with one FlexStatement per account) to a statement.
 * Holdings: OpenPositions (SUMMARY rows) and CashReport ending cash per currency (BASE_SUMMARY is a
 * base-currency roll-up and skipped). Transactions: Trades (EXECUTION rows) and CashTransactions
 * (dividends, withholding tax, interest, fees, deposits). ChangeInDividendAccruals are accruals, not
 * cash, and are not transactions. Daily values: EquitySummaryInBase > EquitySummaryByReportDateInBase (the
 * "Net Asset Value (NAV) in Base" section), one `total` per `reportDate` in the row's `currency` (else the
 * account's base currency). `asOf` is the latest statement `toDate`.
 */
export function mapFlexStatement(xml: string): InvestStatement {
  const root = parseXml(xml);
  if (root.name !== "FlexQueryResponse") throw new FlexError("other", null, `Expected FlexQueryResponse, got <${root.name}>`, { element: root.name });
  const statements = childrenNamed(child(root, "FlexStatements") ?? root, "FlexStatement");
  const warnings: Notice[] = [];
  const accounts: InvestAccountRow[] = [];
  const secs = new Map<string, InvestSecurityRow>();
  const holdings: InvestHoldingRow[] = [];
  const transactions: InvestTxnRow[] = [];
  const navs: InvestNavRow[] = [];
  const sections = new Set<FlexSectionId>();
  let asOf: string | null = null;
  // Positions carry the fullest description of a contract; later rows only fill gaps.
  const keep = (s: InvestSecurityRow) => {
    const prev = secs.get(s.externalId);
    if (!prev) secs.set(s.externalId, s);
    else for (const k of Object.keys(s) as (keyof InvestSecurityRow)[]) if (prev[k] == null && s[k] != null) Object.assign(prev, { [k]: s[k] });
  };

  for (const st of statements) {
    const accountId = str(st.attrs.accountId);
    if (!accountId) {
      warnings.push(notice("invest_statement_without_account", "FlexStatement without accountId skipped"));
      continue;
    }
    for (const id of FLEX_SECTION_IDS) if (child(st, FLEX_SECTIONS[id])) sections.add(id);
    const info = child(st, "AccountInformation");
    const to = flexDate(st.attrs.toDate) ?? flexDate(st.attrs.whenGenerated);
    if (to && (!asOf || to > asOf)) asOf = to;
    const baseCurrency = (str(info?.attrs.currency) ?? "USD").toUpperCase();
    accounts.push({
      externalId: accountId,
      name: str(info?.attrs.acctAlias) ?? str(st.attrs.acctAlias) ?? `IBKR ${accountId}`,
      currency: baseCurrency,
    });

    // One row per day (a later row for the same day replaces an earlier one); rows of another account
    // (a consolidated statement) are skipped.
    const navByDay = new Map<string, InvestNavRow>();
    for (const n of childrenNamed(child(st, "EquitySummaryInBase") ?? st, "EquitySummaryByReportDateInBase")) {
      const rowAccount = str(n.attrs.accountId);
      if (rowAccount && rowAccount !== accountId) continue;
      const date = flexDate(n.attrs.reportDate);
      const total = dec(n.attrs.total);
      if (!date || total == null) continue;
      const currency = (str(n.attrs.currency) ?? baseCurrency).toUpperCase();
      if (!/^[A-Z]{3}$/.test(currency)) continue;
      navByDay.set(date, { accountExternalId: accountId, date, currency, total, raw: attrsOf(n) });
    }
    navs.push(...[...navByDay.values()].sort((x, y) => x.date.localeCompare(y.date)));

    for (const p of childrenNamed(child(st, "OpenPositions") ?? st, "OpenPosition")) {
      if (!isSummary(p, ["SUMMARY"])) continue;
      const s = security(p, warnings);
      const quantity = dec(p.attrs.position);
      const marketValue = dec(p.attrs.positionValue);
      if (!s || quantity == null || marketValue == null) {
        if (s) warnings.push(notice("invest_position_incomplete", `Position ${s.externalId} without position/positionValue skipped`, { securityId: s.externalId }));
        continue;
      }
      keep(s);
      holdings.push({
        accountExternalId: accountId,
        securityExternalId: s.externalId,
        currency: s.currency,
        quantity,
        price: dec(p.attrs.markPrice) ?? "0",
        marketValue,
        costBasis: dec(p.attrs.costBasisMoney),
        raw: attrsOf(p),
      });
    }

    for (const c of childrenNamed(child(st, "CashReport") ?? st, "CashReportCurrency")) {
      const currency = (str(c.attrs.currency) ?? "").toUpperCase();
      if (!/^[A-Z]{3}$/.test(currency)) continue; // BASE_SUMMARY
      if (!isSummary(c, ["SUMMARY", "CURRENCY"])) continue;
      const ending = dec(c.attrs.endingCash);
      if (ending == null) continue;
      holdings.push({
        accountExternalId: accountId,
        securityExternalId: null,
        currency,
        quantity: ending,
        price: "1",
        marketValue: ending,
        costBasis: null,
        raw: attrsOf(c),
      });
    }

    for (const t of childrenNamed(child(st, "Trades") ?? st, "Trade")) {
      if (!isSummary(t, ["EXECUTION"])) continue;
      const s = security(t, warnings);
      const id = str(t.attrs.transactionID) ?? str(t.attrs.tradeID);
      const date = flexDate(t.attrs.tradeDate) ?? flexDate(t.attrs.dateTime) ?? flexDate(t.attrs.reportDate);
      const amount = dec(t.attrs.netCash) ?? dec(t.attrs.proceeds);
      if (!s || !id || !date || amount == null) continue;
      keep(s);
      const side = (t.attrs.buySell ?? "").toUpperCase();
      transactions.push({
        accountExternalId: accountId,
        securityExternalId: s.externalId,
        externalId: `trade:${id}`,
        date,
        type: side.startsWith("SELL") ? "sell" : side.startsWith("BUY") ? "buy" : "other",
        quantity: dec(t.attrs.quantity),
        amount,
        currency: s.currency,
        description: str(t.attrs.description),
        raw: attrsOf(t),
      });
    }

    for (const c of childrenNamed(child(st, "CashTransactions") ?? st, "CashTransaction")) {
      if (!isSummary(c, ["DETAIL"])) continue;
      const id = str(c.attrs.transactionID);
      const date = flexDate(c.attrs.dateTime) ?? flexDate(c.attrs.settleDate) ?? flexDate(c.attrs.reportDate);
      const amount = dec(c.attrs.amount);
      if (!id || !date || amount == null) continue;
      const s = str(c.attrs.conid) ? security(c, warnings) : null;
      if (s) keep(s);
      transactions.push({
        accountExternalId: accountId,
        securityExternalId: s?.externalId ?? null,
        externalId: `cash:${id}`,
        date,
        type: cashKind(c.attrs.type ?? ""),
        quantity: null,
        amount,
        currency: (str(c.attrs.currency) ?? "USD").toUpperCase(),
        description: str(c.attrs.description) ?? str(c.attrs.type),
        raw: attrsOf(c),
      });
    }
  }

  if (!asOf) throw new FlexError("other", null, "The Flex statement has no toDate");
  return { source: "ibkr", asOf, accounts, securities: [...secs.values()], holdings, transactions, navs, sections: FLEX_SECTION_IDS.filter((id) => sections.has(id)), warnings };
}
