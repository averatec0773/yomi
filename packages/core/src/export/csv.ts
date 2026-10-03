import type { Db } from "@yomi/db";
import { LedgerError } from "../ledger/errors";
import { countsAsSpending } from "../ledger/share";
import { listTransactions, type TransactionItem } from "../ledger/transactions";
import { formatMinorDecimal } from "../money";
import { type Statement, type StatementScope, statementCategory, statementText } from "../split/statement";
import { isDate, isMonth } from "../time/day";
import { getTimeZone } from "../settings/time-zone";
import { occurredTimeFor } from "../time/zone";
import type { CurrentUser } from "../user";

const BOM = "﻿";
const PAGE = 5000;

/** Language of CSV headers and labels; data (merchants, categories, names, notes) stays as stored. */
export type CsvLocale = "en" | "zh-CN";

interface CsvLabels {
  kind: Record<TransactionItem["kind"], string>;
  source: Record<TransactionItem["source"], string>;
  transactionColumns: readonly string[];
  splitColumns: readonly string[];
  me: string;
  carried: string;
  opening: string;
  shared: string;
  settledToMe: string;
  settledByMe: string;
  actual: string;
  total: string;
  scopeTotal: string;
  settledOn: (date: string) => string;
  splitColumn: string;
  myShareColumn: (myName: string | null) => string;
  categoryColumn: string;
  splitWays: (count: number, names: readonly string[] | null) => string;
  theyOwe: (name: string) => string;
  iOwe: (name: string) => string;
  even: string;
}

const LABELS: Record<CsvLocale, CsvLabels> = {
  en: {
    kind: { expense: "Expense", income: "Income", transfer: "Transfer", refund: "Refund" },
    source: { alipay: "Alipay", wechat: "WeChat", icbc_pdf: "ICBC credit card", plaid: "Bank sync", boa_csv: "Bank of America CSV", sms: "SMS", manual: "Manual" },
    transactionColumns: ["Date", "Time", "Merchant", "Description", "Category", "Type", "Amount", "Currency", "My share", "Split", "Payer", "Account", "Source", "Note"],
    splitColumns: ["Date", "Type", "Merchant", "Total", "Their share", "Payer", "Change", "Note"],
    me: "Me",
    carried: "Carried over",
    opening: "Opening balance",
    shared: "Shared expense",
    settledToMe: "Settlement (they paid me)",
    settledByMe: "Settlement (I paid them)",
    actual: "actual",
    total: "Total",
    scopeTotal: "Total of these items",
    settledOn: (d) => `Settled on ${d}`,
    splitColumn: "Split",
    myShareColumn: (me) => (me ? `${me}'s share` : "My share"),
    categoryColumn: "Category",
    splitWays: (n, names) => `Split ${n} ways${names && names.length > 0 ? ` (with ${names.join(", ")})` : ""}`,
    theyOwe: (name) => `${name} owes me`,
    iOwe: (name) => `I owe ${name}`,
    even: "All square",
  },
  "zh-CN": {
    kind: { expense: "支出", income: "收入", transfer: "转账", refund: "退款" },
    source: { alipay: "支付宝", wechat: "微信", icbc_pdf: "工商银行信用卡", plaid: "银行同步", boa_csv: "美国银行 CSV", sms: "短信", manual: "手动" },
    transactionColumns: ["日期", "时间", "商户", "说明", "分类", "类型", "金额", "币种", "我承担", "分摊", "付款人", "账户", "来源", "备注"],
    splitColumns: ["日期", "类型", "商户", "总额", "对方份额", "付款人", "变动", "备注"],
    me: "我",
    carried: "此前结余",
    opening: "期初余额",
    shared: "共同支出",
    settledToMe: "结算（对方转我）",
    settledByMe: "结算（我转对方）",
    actual: "实际",
    total: "合计",
    scopeTotal: "所选账目合计",
    settledOn: (d) => `${d} 已结清`,
    splitColumn: "分摊",
    myShareColumn: (me) => (me ? `${me}的份额` : "我的份额"),
    categoryColumn: "分类",
    splitWays: (n, names) => `${n} 人分摊${names && names.length > 0 ? `（和 ${names.join("、")}）` : ""}`,
    theyOwe: (name) => `${name}欠我`,
    iOwe: (name) => `我欠${name}`,
    even: "已结清",
  },
};

export const TRANSACTION_CSV_COLUMNS = LABELS.en.transactionColumns;

function cell(v: string): string {
  return /[",\r\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
}

/** RFC 4180 CSV with CRLF line ends and a UTF-8 BOM, so Excel opens non-ASCII text correctly. */
export function toCsv(rows: readonly (readonly string[])[]): string {
  return BOM + rows.map((r) => r.map(cell).join(",")).join("\r\n") + "\r\n";
}

function transactionRow(t: TransactionItem, l: CsvLabels, timeZone: string): string[] {
  const c = t.currency;
  const others = t.splits.filter((s) => !s.isSelf);
  const self = t.splits.filter((s) => s.isSelf);
  const name = (s: TransactionItem["splits"][number]) => (s.isSelf ? l.me : s.name);
  const split = [...others, ...self].map((s) => `${name(s)} ${formatMinorDecimal(s.owedMinor, c)}`).join("; ");
  const payer = t.splits.find((s) => s.paidMinor !== 0) ?? self[0];
  return [
    t.occurredOn,
    occurredTimeFor(t.occurredAt, t.source, timeZone),
    t.merchant,
    t.description,
    t.categoryName ?? "",
    l.kind[t.kind],
    formatMinorDecimal(t.amountMinor, c),
    c,
    countsAsSpending(t) ? formatMinorDecimal(t.myShareMinor, c) : "",
    split,
    t.splits.length > 0 && payer ? name(payer) : "",
    t.accountName ?? "",
    l.source[t.source] ?? t.source,
    t.note ?? "",
  ];
}

/**
 * The transaction list as CSV (oldest first), for one month, a date range or everything. Same rows the list
 * shows by default: closed rows and bank rows linked to a wallet row are left out, so Amount and
 * My share sum without double counting. Headers and labels in `locale` (default English).
 */
export async function exportTransactionsCsv(
  db: Db,
  user: CurrentUser,
  opts: { month?: string; from?: string; to?: string; locale?: CsvLocale } = {},
): Promise<string> {
  const l = LABELS[opts.locale ?? "en"];
  if (opts.month !== undefined && !isMonth(opts.month)) throw new LedgerError("invalid", "invalid_month", `Invalid month: ${opts.month}`, { value: opts.month });
  if (opts.from !== undefined || opts.to !== undefined) {
    if (opts.from === undefined || opts.to === undefined) throw new LedgerError("invalid", "range_needs_both", "Give both the start and the end date");
    if (!isDate(opts.from) || !isDate(opts.to) || opts.from > opts.to) {
      throw new LedgerError("invalid", "invalid_range", `Invalid date range: ${opts.from} ~ ${opts.to}`, { from: opts.from, to: opts.to });
    }
  }
  const items: TransactionItem[] = [];
  for (let offset = 0; ; offset += PAGE) {
    const page = await listTransactions(db, user, { month: opts.month, from: opts.from, to: opts.to, limit: PAGE, offset });
    items.push(...page.items);
    if (page.items.length < PAGE) break;
  }
  const zone = await getTimeZone(db, user);
  const rows = items
    .filter((t) => t.status === "ok" && t.duplicateOfId == null)
    .reverse()
    .map((t) => transactionRow(t, l, zone));
  return toCsv([[...l.transactionColumns], ...rows]);
}

export const SPLIT_CSV_COLUMNS = LABELS.en.splitColumns;

/**
 * The statement shown on /split (same window as statementText) as CSV: shared expenses and
 * settlements in date order, then the balance. Change is signed like the balance: positive means
 * the participant owes me more. Scope "all" widens the window to the whole history; scope
 * "selected" lists only the chosen items and their total (what is still open on them). Settled
 * items carry the day they were settled in the note column (scopes "all" and "selected").
 * `show` (statement flags) adds the shared note to Note, appends Split / My share / Category
 * columns, and drops settlement rows when "settlements" is off (Change then no longer sums to Total).
 */
export async function exportSplitCsv(
  db: Db,
  user: CurrentUser,
  participantId: number,
  currency: string,
  opts: { since?: string; locale?: CsvLocale; scope?: StatementScope; itemIds?: readonly number[]; show?: readonly string[] } = {},
): Promise<string> {
  const l = LABELS[opts.locale ?? "en"];
  const s = await statementText(db, user, participantId, currency, opts);
  const c = s.currency;
  const on = (f: Statement["show"][number]) => s.show.includes(f);
  const m = (v: number) => formatMinorDecimal(v, c);
  const entryOf = new Map(s.entries.map((e) => [e.transactionId, e]));
  const settledNote = (id: number) => {
    const settledOn = entryOf.get(id)?.settledOn;
    return s.scope !== "open" && settledOn ? l.settledOn(settledOn) : "";
  };
  // Optional columns after Note, in the order of the options.
  const extraHeaders = [on("shared") && l.splitColumn, on("myshare") && l.myShareColumn(s.myName), on("category") && l.categoryColumn].filter(
    (h): h is string => typeof h === "string",
  );
  const pad = (row: string[]) => [...row, ...extraHeaders.map(() => "")];
  const itemRow = (it: Statement["items"][number]) => [
    it.date,
    l.shared,
    it.merchant,
    m(it.totalMinor),
    m(it.theirShareMinor),
    it.paidByThem ? s.participantName : l.me,
    m(it.deltaMinor),
    [on("notes") ? (entryOf.get(it.transactionId)?.sharedNote ?? "") : "", settledNote(it.transactionId)].filter(Boolean).join("; "),
    ...(on("shared") ? [it.sharedWith.length > 0 ? l.splitWays(it.splitCount, on("names") ? it.sharedWith : null) : ""] : []),
    ...(on("myshare") ? [m(it.myShareMinor)] : []),
    ...(on("category") ? [it.category ? statementCategory(it.category, opts.locale ?? "en") : ""] : []),
  ];
  const header = [...l.splitColumns, ...extraHeaders];
  if (s.scope === "selected") {
    const total = s.scopeRemainingMinor;
    const balance = total > 0 ? l.theyOwe(s.participantName) : total < 0 ? l.iOwe(s.participantName) : l.even;
    return toCsv([header, ...s.scopeItems.map(itemRow), pad(["", l.scopeTotal, "", "", "", "", m(total), balance])]);
  }
  const rows: string[][] = [];
  if (s.openingMinor !== 0) rows.push(pad([s.since ?? "", l.carried, "", "", "", "", m(s.openingMinor), ""]));
  if (s.openingBalanceMinor !== 0) rows.push(pad([s.since ?? "", l.opening, "", "", "", "", m(s.openingBalanceMinor), ""]));
  const events: { date: string; row: string[] }[] = [
    ...s.items.map((it) => ({ date: it.date, row: itemRow(it) })),
    ...(on("settlements") ? s.settlements : []).map((st) => {
      const orig =
        st.originalAmountMinor !== null && st.originalCurrency
          ? `${l.actual} ${formatMinorDecimal(Math.abs(st.originalAmountMinor), st.originalCurrency)} ${st.originalCurrency}`
          : "";
      return {
        date: st.date,
        row: pad([
          st.date,
          st.amountMinor > 0 ? l.settledToMe : l.settledByMe,
          "",
          m(Math.abs(st.amountMinor)),
          "",
          st.amountMinor > 0 ? s.participantName : l.me,
          m(-st.amountMinor),
          [st.note ?? "", orig].filter(Boolean).join("; "),
        ]),
      };
    }),
  ];
  events.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  rows.push(...events.map((e) => e.row));
  const balance = s.balanceMinor > 0 ? l.theyOwe(s.participantName) : s.balanceMinor < 0 ? l.iOwe(s.participantName) : l.even;
  rows.push(pad(["", l.total, "", "", "", "", m(s.balanceMinor), balance]));
  return toCsv([header, ...rows]);
}
