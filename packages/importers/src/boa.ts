import { type Notice, notice, ParseError } from "./errors";
import type { DeclaredTotals, NormalizedRow, ParseResult } from "./types";
import { parseAmountMinor } from "./util/amount";
import { clean, isBlankRow, parseCsv, stripBom } from "./util/csv";

/**
 * Bank of America gives dates only. Rows are stored at noon US Eastern standard time, the same
 * convention as Plaid rows, so the two sources compare by calendar day.
 */
export const BOA_TIME_SUFFIX = "T12:00:00-05:00";

export const BOA_CHECKING_METHOD = "Bank of America 支票";
export const BOA_CARD_METHOD = "Bank of America 信用卡";

const CHECKING_HEADER = ["Date", "Description", "Amount", "Running Bal."] as const;
const CARD_REQUIRED = ["Posted Date", "Reference Number", "Payee", "Amount"] as const;

export type BoaCsvVariant = "checking" | "card";

/** Which BoA CSV this is, from its first non-blank line; null when it is not one. */
export function boaCsvVariant(firstLine: string): BoaCsvVariant | null {
  const line = stripBom(firstLine).trim();
  if (/^Description,,Summary Amt\.?/.test(line) || /^Date,Description,Amount,Running Bal\./.test(line)) return "checking";
  if (/^Posted Date,Reference Number,Payee\b/.test(line)) return "card";
  return null;
}

export interface BoaDescription {
  kind: NormalizedRow["kind"];
  counterparty: string;
  /** Zelle / Purchase / Wire / Fee / Transfer / ATM / Deposit / Payroll / ACH / Interest / Rewards; null = fallback. */
  sourceCategory: string | null;
}

const collapse = (s: string) => s.replace(/\s+/g, " ").trim();

/** `1/JOHN DOE` (SWIFT line prefix) → `JOHN DOE`. */
const stripLinePrefix = (s: string) => s.replace(/^\d\//, "").trim();

const ZELLE_RE = /^Zelle\s+(?:payment|transfer)\s+(to|from)\s+(.+?)(?:\s+for\s+.*?)?\s+Conf#.*$/i;
const ZELLE_NO_CONF_RE = /^Zelle\s+(?:payment|transfer)\s+(to|from)\s+(.+)$/i;
const ZELLE_LEGACY_RE = /^Zelle\s+Transfer\s+Conf#\s*\S+?;\s*(.+)$/i;

/** The other person of a Zelle description (`Zelle payment from NAME Conf# x`), or null when it is not one. */
export function zelleCounterparty(description: string): { name: string; direction: "to" | "from" | null } | null {
  const d = collapse(description);
  const m = ZELLE_RE.exec(d) ?? ZELLE_NO_CONF_RE.exec(d);
  if (m) return { name: m[2]!.trim(), direction: m[1]!.toLowerCase() as "to" | "from" };
  const legacy = ZELLE_LEGACY_RE.exec(d);
  if (legacy) return { name: legacy[1]!.trim(), direction: null };
  return null;
}

const PURCHASE_RE = /^(.*?)\s+\d{2}\/\d{2}\s+(?:MOBILE\s+)?PURCHASE\b(?:\s+(?:RETURN|REFUND)\b)?\s*(.*)$/i;
const CHECKCARD_RE = /^CHECKCARD\s+\d{4}\s+(.+)$/i;
const WIRE_RE = /^WIRE\s+TYPE:\S*\s+(IN|OUT)\b/i;
const CARD_ISSUER_RE =
  /CREDIT\s*CRD|\bCRD\b|CARD|AMEX|AMERICAN\s+EXPRESS|\bCHASE\b|\bCITI|DISCOVER|CAPITAL\s+ONE|BARCLAY|SYNCHRONY|GSBANK|BK\s+OF\s+AMER|BANK\s+OF\s+AMERICA|BKOFAMERICA/i;
const PAYROLL_RE = /PAYROLL|PAYRLL|DIR\s*DEP|DIRECT\s*DEP|SALARY/i;

/** Merchant part of a card purchase line: drops the CHECKCARD date, reference numbers and RECURRING. */
function purchaseMerchant(text: string): string {
  let s = collapse(text);
  const cc = CHECKCARD_RE.exec(s);
  if (cc) s = cc[1]!;
  s = s.replace(/\s+\d{10,}.*$/, "").replace(/\s+RECURRING$/i, "");
  return collapse(s);
}

/**
 * Kind, counterparty and a coarse category from a BoA checking description. Only the sign of the
 * amount and the text are used. Shapes (checked against a real 2026 checking export, masked):
 * - `MERCHANT MM/DD [MOBILE] PURCHASE CITY ST` (older exports: `CHECKCARD MMDD MERCHANT ... ref`) → expense / refund if positive
 * - `Zelle payment to|from NAME [for "memo";] Conf# id` → expense / income, so repayments reach the split screen
 * - `WIRE TYPE:INTL IN ... ORIG:1/NAME ID:...` → income; `... OUT ... BNF:NAME ID:` → expense (who received it is unknown, so it is not a transfer)
 * - `Wire Transfer Fee`, `... FEE` → expense Fee
 * - `COMPANY DES:X ID:... INDN:... CO ID:... PPD|WEB|CCD` (ACH): payroll → income Payroll; a card issuer paid → transfer;
 *   DES transfer → transfer; otherwise income/expense ACH
 * - `Online Banking payment to CRD 1234`, `Online Banking transfer to|from ...`, `BA ELECTRONIC PAYMENT` → transfer
 * - `BKOFAMERICA ATM ... WITHDRWL` → transfer ATM (cash leaves the ledger's view, as Plaid classifies it)
 * - `BKOFAMERICA MOBILE ... DEPOSIT` → income Deposit; interest → income Interest; cash back / rewards → income Rewards
 */
export function parseBoaDescription(description: string, amountMinor: number): BoaDescription {
  const d = collapse(description);
  const inflow = amountMinor > 0;
  const bySign = inflow ? "income" : "expense";

  const zelle = zelleCounterparty(d);
  if (zelle) return { kind: bySign, counterparty: zelle.name, sourceCategory: "Zelle" };

  const wire = WIRE_RE.exec(d);
  if (wire) {
    const incoming = wire[1]!.toUpperCase() === "IN";
    const party = (incoming ? /\bORIG:(.+?)\s+ID:/ : /\bBNF:(.+?)\s+ID:/).exec(d);
    return {
      kind: inflow ? "income" : "expense",
      counterparty: party ? stripLinePrefix(party[1]!) : incoming ? "Incoming wire" : "Outgoing wire",
      sourceCategory: "Wire",
    };
  }

  const purchase = PURCHASE_RE.exec(d);
  if (purchase || CHECKCARD_RE.test(d)) {
    const merchant = purchaseMerchant(purchase ? purchase[1]! : d);
    return { kind: inflow ? "refund" : "expense", counterparty: merchant || d, sourceCategory: "Purchase" };
  }

  if (/\bATM\b/i.test(d) && /WITHDRWL|WITHDRAWAL|DEPOSIT/i.test(d)) {
    return { kind: "transfer", counterparty: "ATM", sourceCategory: "ATM" };
  }

  const crd = /Online\s+Banking\s+payment\s+to\s+CRD\s*(\d{4})?/i.exec(d);
  if (crd) return { kind: "transfer", counterparty: crd[1] ? `Credit card ${crd[1]}` : "Credit card", sourceCategory: "Transfer" };
  if (/Online\s+Banking\s+transfer\b|^BA\s+ELECTRONIC\s+PAYMENT\b/i.test(d)) {
    return { kind: "transfer", counterparty: d.replace(/\s+Confirmation#.*$/i, ""), sourceCategory: "Transfer" };
  }

  const ach = /^(.*?)\s+DES:(.*?)(?:\s+ID:|\s+INDN:|$)/.exec(d);
  if (ach) {
    const company = collapse(ach[1]!);
    const des = collapse(ach[2]!);
    if (inflow && PAYROLL_RE.test(des)) return { kind: "income", counterparty: company, sourceCategory: "Payroll" };
    if (CARD_ISSUER_RE.test(`${company} ${des}`) && /PAY|PMT/i.test(des)) {
      return { kind: "transfer", counterparty: company, sourceCategory: "Transfer" };
    }
    if (/TRANSFER|XFER|TRNSFR/i.test(des)) return { kind: "transfer", counterparty: company, sourceCategory: "Transfer" };
    return { kind: bySign, counterparty: company, sourceCategory: "ACH" };
  }

  if (/^BKOFAMERICA\b.*\bPAYMENT\b|CREDIT\s+CRD.*\bPAYMENT\b/i.test(d)) {
    return { kind: "transfer", counterparty: "Bank of America", sourceCategory: "Transfer" };
  }
  if (inflow && /\bDEPOSIT\b/i.test(d)) {
    return { kind: "income", counterparty: /MOBILE/i.test(d) ? "Mobile deposit" : "Deposit", sourceCategory: "Deposit" };
  }
  if (inflow && /\bINTEREST\b/i.test(d)) return { kind: "income", counterparty: d, sourceCategory: "Interest" };
  if (inflow && /CASH\s?BACK|REWARD/i.test(d)) return { kind: "income", counterparty: d, sourceCategory: "Rewards" };
  if (!inflow && /\bFEE\b/i.test(d)) return { kind: "expense", counterparty: d, sourceCategory: "Fee" };

  return { kind: bySign, counterparty: d, sourceCategory: null };
}

function boaAmountMinor(text: string): number {
  return parseAmountMinor(text.replace(/\$/g, ""));
}

/** `09/12/2026` → `2026-09-12`. */
function boaDate(text: string): string {
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(text.trim());
  if (!m) throw new ParseError("import_bad_date", `Bank of America statement: cannot parse date ${JSON.stringify(text)}`, { value: text });
  return `${m[3]}-${m[1]!.padStart(2, "0")}-${m[2]!.padStart(2, "0")}`;
}

function direction(amountMinor: number): NormalizedRow["direction"] {
  return amountMinor > 0 ? "in" : amountMinor < 0 ? "out" : "neutral";
}

function headerIndex(cells: readonly string[]): Map<string, number> {
  const index = new Map<string, number>();
  cells.forEach((h, i) => {
    const name = clean(h);
    if (name !== "" && !index.has(name)) index.set(name, i);
  });
  return index;
}

/**
 * Bank of America CSV ("Microsoft Excel format" download). Two layouts:
 * - Checking/savings: a summary block (`Description,,Summary Amt.`, beginning balance, total credits,
 *   total debits, ending balance), a blank line, then `Date,Description,Amount,Running Bal.`; the first
 *   data row is the beginning balance with no amount and is skipped. Declared totals come from the
 *   summary; beginning + Σ amounts must equal the ending balance.
 * - Credit card: `Posted Date,Reference Number,Payee,Address,Amount`, no summary. Sign assumed
 *   BoA-style (charges negative, payments and credits positive), inferred rather than documented;
 *   a negative `PAYMENT` row triggers a warning.
 * Amounts are signed already (negative = money leaving me), parsed with string arithmetic.
 */
export function parseBoaCsv(bytes: Uint8Array): ParseResult {
  const text = stripBom(new TextDecoder("utf-8").decode(bytes));
  const lines = parseCsv(text);
  const first = lines.find((c) => !isBlankRow(c));
  const variant = first ? boaCsvVariant(first.join(",")) : null;
  if (variant === "card") return parseCard(lines);
  return parseChecking(lines);
}

function parseChecking(lines: string[][]): ParseResult {
  const headerAt = lines.findIndex((c) => CHECKING_HEADER.every((h, i) => clean(c[i]) === h));
  if (headerAt < 0) throw new ParseError("import_header_not_found", "Bank of America statement: header row not found (Date,Description,Amount,Running Bal.)", { header: "Date,Description,Amount,Running Bal." });

  let beginning: { date: string; minor: number } | null = null;
  let ending: { date: string; minor: number } | null = null;
  let credits: number | null = null;
  let debits: number | null = null;
  for (const cells of lines.slice(0, headerAt)) {
    const label = clean(cells[0]);
    const value = clean(cells[2]);
    if (!value) continue;
    const asOf = /^(Beginning|Ending) balance as of (\d{1,2}\/\d{1,2}\/\d{4})$/i.exec(label);
    if (asOf) {
      const v = { date: boaDate(asOf[2]!), minor: boaAmountMinor(value) };
      if (asOf[1]!.toLowerCase() === "beginning") beginning = v;
      else ending = v;
    } else if (/^Total credits$/i.test(label)) credits = boaAmountMinor(value);
    else if (/^Total debits$/i.test(label)) debits = boaAmountMinor(value);
  }

  const index = headerIndex(lines[headerAt]!);
  const warnings: Notice[] = [];
  const rows: NormalizedRow[] = [];
  for (let i = headerAt + 1; i < lines.length; i++) {
    const cells = lines[i]!;
    if (isBlankRow(cells)) continue;
    const get = (name: string) => clean(cells[index.get(name) ?? -1]);
    const description = collapse(get("Description"));
    const amountText = get("Amount");
    if (amountText === "") {
      const opening = /^Beginning balance as of (\d{1,2}\/\d{1,2}\/\d{4})$/i.exec(description);
      if (opening && !beginning) beginning = { date: boaDate(opening[1]!), minor: boaAmountMinor(get("Running Bal.")) };
      else if (!opening) warnings.push(notice("import_line_no_amount", `Line ${i + 1} has no amount, skipped`, { line: i + 1 }));
      continue;
    }
    const raw: Record<string, string> = {};
    for (const [name, at] of index) raw[name] = cells[at] ?? "";
    const amountMinor = boaAmountMinor(amountText);
    const parsed = parseBoaDescription(description, amountMinor);
    rows.push({
      source: "boa_csv",
      lineNo: rows.length + 1,
      externalId: null,
      occurredAt: `${boaDate(get("Date"))}${BOA_TIME_SUFFIX}`,
      amountMinor,
      currency: "USD",
      originalAmountMinor: null,
      originalCurrency: null,
      direction: direction(amountMinor),
      kind: parsed.kind,
      status: "ok",
      counterparty: parsed.counterparty,
      description,
      sourceCategory: parsed.sourceCategory,
      paymentMethod: BOA_CHECKING_METHOD,
      raw,
    });
  }

  const declared: DeclaredTotals = {};
  if (credits !== null) declared.income = { count: rows.filter((r) => r.amountMinor > 0).length, minor: Math.abs(credits) };
  if (debits !== null) declared.expense = { count: rows.filter((r) => r.amountMinor < 0).length, minor: Math.abs(debits) };
  if (beginning && ending) {
    const sum = rows.reduce((s, r) => s + r.amountMinor, 0);
    if (beginning.minor + sum !== ending.minor) {
      warnings.push(
        notice(
          "import_balance_mismatch",
          `Balances do not add up: beginning ${beginning.minor} + period total ${sum} ≠ ending ${ending.minor} (minor units)`,
          { beginningMinor: beginning.minor, sumMinor: sum, endingMinor: ending.minor },
        ),
      );
    }
  }
  return {
    source: "boa_csv",
    rows,
    declared,
    periodStart: beginning ? `${beginning.date}T00:00:00-05:00` : undefined,
    periodEnd: ending ? `${ending.date}T23:59:59-05:00` : undefined,
    warnings,
  };
}

function parseCard(lines: string[][]): ParseResult {
  const headerAt = lines.findIndex((c) => clean(c[0]) === "Posted Date");
  const index = headerIndex(lines[headerAt]!);
  const missing = CARD_REQUIRED.filter((h) => !index.has(h));
  if (missing.length) throw new ParseError("import_missing_columns", `Bank of America card statement: missing columns ${missing.join(", ")}`, { columns: missing.join(", ") });

  const warnings: Notice[] = [];
  const rows: NormalizedRow[] = [];
  for (let i = headerAt + 1; i < lines.length; i++) {
    const cells = lines[i]!;
    if (isBlankRow(cells)) continue;
    const get = (name: string) => clean(cells[index.get(name) ?? -1]);
    const payee = collapse(get("Payee"));
    const amountMinor = boaAmountMinor(get("Amount"));
    const lineNo = rows.length + 1;
    const isPayment = /\bPAYMENT\b/i.test(payee);
    if (isPayment && amountMinor < 0) warnings.push(
        notice("import_negative_payment", `Row ${lineNo}: a payment is negative, the sign convention may be reversed; please check`, { line: lineNo }),
      );

    let kind: NormalizedRow["kind"];
    let sourceCategory: string;
    if (amountMinor > 0) {
      kind = isPayment ? "transfer" : "refund";
      sourceCategory = isPayment ? "Transfer" : "Purchase";
    } else {
      kind = "expense";
      sourceCategory = /\bFEE\b|INTEREST\s+CHARGE/i.test(payee) ? "Fee" : "Purchase";
    }
    const raw: Record<string, string> = {};
    for (const [name, at] of index) raw[name] = cells[at] ?? "";
    rows.push({
      source: "boa_csv",
      lineNo,
      externalId: get("Reference Number") || null,
      occurredAt: `${boaDate(get("Posted Date"))}${BOA_TIME_SUFFIX}`,
      amountMinor,
      currency: "USD",
      originalAmountMinor: null,
      originalCurrency: null,
      direction: direction(amountMinor),
      kind,
      status: "ok",
      counterparty: isPayment && amountMinor > 0 ? "Bank of America" : purchaseMerchant(payee) || payee,
      description: [payee, collapse(get("Address"))].filter(Boolean).join(" "),
      sourceCategory,
      paymentMethod: BOA_CARD_METHOD,
      raw,
    });
  }
  return { source: "boa_csv", rows, declared: {}, warnings };
}
