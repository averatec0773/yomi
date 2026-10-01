import { type Notice, notice } from "../errors";
import type { DeclaredTotals, NormalizedRow, ParseResult } from "../types";

/** One positioned text item in display coordinates (origin top-left, y down). */
export interface TextItem {
  str: string;
  x: number;
  /** Baseline y. */
  y: number;
  w: number;
  size: number;
  /** Degrees; table text is 0, the diagonal watermark is not. */
  angle: number;
}

const COLUMNS = [
  "入账日期",
  "交易卡号",
  "收/支",
  "交易币种",
  "交易金额",
  "入账币种",
  "入账金额",
  "账户余额",
  "对方户名",
  "对方账号",
  "摘要",
  "交易场所",
] as const;
type Column = (typeof COLUMNS)[number];

const CURRENCY: Record<string, string> = { 美元: "USD", 港币: "HKD", 人民币: "CNY" };

const EXPENSE_SUM = /本页支出算术合计[：:]\s*([\d,]+\.\d{2})/;
const INCOME_SUM = /本页收入算术合计[：:]\s*([\d,]+\.\d{2})/;
const PAGE_COUNT = /本页交易笔数[：:]\s*(\d+)/;
const PERIOD = /起止日期[：:]\s*(\d{4}-\d{2}-\d{2})\s*\S\s*(\d{4}-\d{2}-\d{2})/;
const CARD = /^\d{16}$/;
const REBATE = /REBATE|CASH\s?BACK/i;

/** Items within this vertical distance of a header label belong to the header (收/支 is stacked on two lines). */
const HEADER_BAND = 6;
/** Max vertical distance from a cell item to its record's card-number baseline (row pitch is 18pt). */
const ROW_REACH = 9;

interface ColumnSpan {
  name: Column;
  center: number;
}

/**
 * Parses the text items of 中国工商银行信用卡历史明细（电子版）.
 *
 * Declared totals: 本页支出算术合计 / 本页收入算术合计 add up 入账金额 across currencies
 * (USD and HKD mixed, no conversion), so declared.expense/income.minor are that mixed sum
 * and reconcile against Σ|amountMinor| over all currencies, not per currency.
 */
export function parseIcbcItems(pages: TextItem[][]): ParseResult {
  const rows: NormalizedRow[] = [];
  const warnings: Notice[] = [];
  const declared = {
    count: 0,
    expense: { count: 0, minor: 0 },
    income: { count: 0, minor: 0 },
  } satisfies Required<Pick<DeclaredTotals, "count" | "expense" | "income">>;
  let periodStart: string | undefined;
  let periodEnd: string | undefined;
  let columns: ColumnSpan[] | null = null;

  pages.forEach((all, pageIdx) => {
    const pageNo = pageIdx + 1;
    // The watermark is drawn diagonally; table text is horizontal.
    const items = all.filter((it) => Math.abs(it.angle) < 1 && it.str.trim() !== "");

    for (const it of items) {
      const period = PERIOD.exec(it.str);
      if (period && !periodStart) {
        periodStart = period[1];
        periodEnd = period[2];
      }
    }

    const header = findHeader(items);
    if (header) columns = header.columns;
    if (!columns) {
      if (items.length > 0) warnings.push(notice("import_page_no_header", `Page ${pageNo}: header row not found`, { page: pageNo }));
      return;
    }

    let pageExpense: number | null = null;
    let pageIncome: number | null = null;
    let pageCount: number | null = null;
    let footerY = Infinity;
    for (const it of items) {
      const e = EXPENSE_SUM.exec(it.str);
      const i = INCOME_SUM.exec(it.str);
      const c = PAGE_COUNT.exec(it.str);
      if (e) pageExpense = toMinor(e[1] ?? "");
      if (i) pageIncome = toMinor(i[1] ?? "");
      if (c) pageCount = Number(c[1]);
      if (e || i || c) footerY = Math.min(footerY, it.y - HEADER_BAND);
    }
    if (pageExpense === null || pageIncome === null || pageCount === null) {
      warnings.push(notice("import_page_no_totals", `Page ${pageNo}: page totals missing`, { page: pageNo }));
    }
    declared.count += pageCount ?? 0;
    declared.expense.minor += pageExpense ?? 0;
    declared.income.minor += pageIncome ?? 0;

    const top = header ? header.y + HEADER_BAND : -Infinity;
    const cols = columns;
    const body = items
      .filter((it) => it.y > top && it.y < footerY)
      .map((it) => ({ it, col: nearestColumn(cols, it) }));

    const anchors = body
      .filter((b) => b.col === "交易卡号" && CARD.test(b.it.str.trim()))
      .map((b) => b.it.y)
      .sort((a, b) => a - b);
    const cells: Map<Column, TextItem[]>[] = anchors.map(() => new Map());

    for (const { it, col } of body) {
      let best = -1;
      let bestDist = Infinity;
      anchors.forEach((y, k) => {
        const d = Math.abs(it.y - y);
        if (d < bestDist) {
          bestDist = d;
          best = k;
        }
      });
      const record = cells[best];
      if (!record || bestDist > ROW_REACH) {
        warnings.push(notice("import_page_stray_text", `Page ${pageNo}: text that belongs to no row (y=${it.y})`, { page: pageNo, y: it.y }));
        continue;
      }
      const list = record.get(col) ?? [];
      list.push(it);
      record.set(col, list);
    }

    if (pageCount !== null && pageCount !== anchors.length) {
      warnings.push(
        notice("import_page_count_mismatch", `Page ${pageNo}: parsed ${anchors.length} rows, the page declares ${pageCount}`, {
          page: pageNo,
          parsed: anchors.length,
          declared: pageCount,
        }),
      );
    }

    for (const record of cells) {
      const text = (col: Column) => cellText(record.get(col) ?? []);
      const row = buildRow(text, rows.length + 1, pageNo, warnings);
      if (!row) continue;
      rows.push(row);
      if (row.direction === "out") declared.expense.count++;
      else declared.income.count++;
    }
  });

  return { source: "icbc_pdf", rows, declared, periodStart, periodEnd, warnings };
}

function buildRow(
  text: (col: Column) => string,
  lineNo: number,
  pageNo: number,
  warnings: Notice[],
): NormalizedRow | null {
  const when = /(\d{4}-\d{2}-\d{2})\s*(\d{2}:\d{2}:\d{2})/.exec(text("入账日期"));
  const card = text("交易卡号");
  const side = text("收/支");
  const summary = text("摘要");
  const bookedCurrency = CURRENCY[text("入账币种")];
  const txnCurrency = CURRENCY[text("交易币种")];
  const booked = toMinor(text("入账金额"));
  const txn = toMinor(text("交易金额"));
  if (!when || (side !== "借" && side !== "贷") || !bookedCurrency || booked === null) {
    warnings.push(notice("import_row_unreadable", `Page ${pageNo} row ${lineNo}: cannot be parsed, skipped`, { page: pageNo, line: lineNo }));
    return null;
  }
  const last4 = card.slice(-4);
  const out = side === "借";
  const place = text("交易场所");
  const foreign = txnCurrency !== undefined && txnCurrency !== bookedCurrency && txn !== null;

  const raw: Record<string, string> = {};
  for (const col of COLUMNS) raw[col] = text(col);
  raw["交易卡号"] = `****${last4}`;

  return {
    source: "icbc_pdf",
    lineNo,
    externalId: null,
    occurredAt: `${when[1]}T${when[2]}+08:00`,
    amountMinor: out ? -booked : booked,
    currency: bookedCurrency,
    originalAmountMinor: foreign ? (out ? -txn : txn) : null,
    originalCurrency: foreign ? txnCurrency : null,
    direction: out ? "out" : "in",
    // Card rebates and cashback are income, not refunds of a purchase.
    kind: out ? "expense" : REBATE.test(place) ? "income" : summary === "退货" ? "refund" : "transfer",
    status: "ok",
    counterparty: place,
    description: summary,
    sourceCategory: summary || null,
    paymentMethod: `工商银行信用卡(${last4})`,
    raw,
  };
}

function findHeader(items: TextItem[]): { y: number; columns: ColumnSpan[] } | null {
  const anchor = items.find((it) => it.str.trim() === "入账日期");
  if (!anchor) return null;
  const band = items.filter((it) => Math.abs(it.y - anchor.y) <= HEADER_BAND);
  const columns: ColumnSpan[] = [];
  for (const name of COLUMNS) {
    const parts =
      name === "收/支"
        ? band.filter((it) => ["收/支", "收", "支"].includes(it.str.trim()))
        : band.filter((it) => it.str.trim() === name);
    if (parts.length === 0) return null;
    const left = Math.min(...parts.map((p) => p.x));
    const right = Math.max(...parts.map((p) => p.x + p.w));
    columns.push({ name, center: (left + right) / 2 });
  }
  return { y: anchor.y, columns };
}

/** Cells are centered under their header, so the nearest header center owns the item. */
function nearestColumn(columns: ColumnSpan[], it: TextItem): Column {
  const mid = it.x + it.w / 2;
  let best = columns[0] as ColumnSpan;
  for (const c of columns) if (Math.abs(c.center - mid) < Math.abs(best.center - mid)) best = c;
  return best.name;
}

/** Joins a cell's items top to bottom, left to right; a visible gap becomes one space. */
function cellText(items: TextItem[]): string {
  const sorted = [...items].sort((a, b) => a.y - b.y || a.x - b.x);
  let out = "";
  let prev: TextItem | null = null;
  for (const it of sorted) {
    if (prev) {
      const sameLine = Math.abs(it.y - prev.y) < 1;
      out += sameLine && it.x - (prev.x + prev.w) < 1 ? "" : " ";
    }
    out += it.str;
    prev = it;
  }
  return out.replace(/\s+/g, " ").trim();
}

function toMinor(s: string): number | null {
  const m = /^(-?)(\d+)(?:\.(\d{1,2}))?$/.exec(s.replace(/,/g, "").trim());
  if (!m) return null;
  const minor = Number(m[2]) * 100 + Number((m[3] ?? "").padEnd(2, "0"));
  return m[1] ? -minor : minor;
}
