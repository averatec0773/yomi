import { type Notice, ParseError } from "./errors";
import ExcelJS from "exceljs";
import type { NormalizedRow, ParseResult } from "./types";
import { numberToMinor, parseAmountMinor } from "./util/amount";
import { clean, parseCsv, stripBom } from "./util/csv";
import { neutralSign } from "./util/neutral";
import { countMismatch, neutralDirectionUnknown, unknownBucket } from "./util/warnings";
import { parsePreamble } from "./util/preamble";
import { excelDateToIso, isoToLocalText, localTextToIso } from "./util/time";

/** A sheet cell as the parser sees it: xlsx keeps Date / number cells typed, CSV is all text. */
type Cell = string | number | Date | null;

const REQUIRED = ["交易时间", "交易类型", "交易对方", "商品", "收/支", "金额(元)", "当前状态", "交易单号"] as const;

/**
 * WeChat Pay statement (账单流水). Current exports are .xlsx (one sheet, merged preamble rows, header row starting
 * with 交易时间, time cells are date serials in UTC+08:00, amounts are number cells); older exports
 * are UTF-8 CSV with a BOM, the same headers and amounts like `¥12.00`.
 *
 * Rules:
 * - 支出 → out / negative / expense; 收入 → in / positive / income (转账 and 红包 included, matching
 *   the file's own summary).
 * - 交易类型 ending in `-退款` → kind refund, positive. A purchase whose 当前状态 is 已全额退款 stays
 *   an expense; the refund arrives as its own row.
 * - `/` (中性交易) → neutral / transfer; sign from keywords (零钱提现 → negative), unmatched → negative + warning.
 */
export async function parseWechat(bytes: Uint8Array, _fileName: string): Promise<ParseResult> {
  const grid = isZip(bytes) ? await readXlsx(bytes) : readCsv(bytes);
  return parseGrid(grid);
}

function isZip(b: Uint8Array): boolean {
  return b[0] === 0x50 && b[1] === 0x4b;
}

async function readXlsx(bytes: Uint8Array): Promise<Cell[][]> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength) as unknown as ExcelJS.Buffer);
  const ws = wb.worksheets[0];
  if (!ws) throw new ParseError("import_no_sheet", "WeChat statement: the xlsx has no worksheet");
  const grid: Cell[][] = [];
  const width = ws.columnCount;
  for (let r = 1; r <= ws.rowCount; r++) {
    const row = ws.getRow(r);
    const cells: Cell[] = [];
    for (let c = 1; c <= width; c++) {
      const cell = row.getCell(c);
      const v = cell.value;
      if (v === null || v === undefined) cells.push(null);
      else if (v instanceof Date || typeof v === "number") cells.push(v);
      else cells.push(cell.text);
    }
    grid.push(cells);
  }
  return grid;
}

function readCsv(bytes: Uint8Array): Cell[][] {
  return parseCsv(stripBom(new TextDecoder("utf-8").decode(bytes)));
}

function text(cell: Cell | undefined): string {
  if (cell === null || cell === undefined) return "";
  if (cell instanceof Date) return isoToLocalText(excelDateToIso(cell));
  return String(cell);
}

function isDataRow(cell: Cell | undefined): boolean {
  return cell instanceof Date || /^\d{4}[-/]\d{1,2}[-/]\d{1,2}/.test(clean(text(cell)));
}

function parseGrid(grid: Cell[][]): ParseResult {
  const headerAt = grid.findIndex((cells) => clean(text(cells[0])) === "交易时间");
  if (headerAt < 0) throw new ParseError("import_header_not_found", "WeChat statement: header row not found (交易时间)", { header: "交易时间" });

  // Merged preamble rows repeat their text in every cell, so only the first cell counts.
  const { declared, periodStart, periodEnd } = parsePreamble(grid.slice(0, headerAt).map((c) => text(c[0])));
  const index = new Map<string, number>();
  grid[headerAt]!.forEach((h, i) => {
    const name = clean(text(h));
    if (name !== "" && !index.has(name)) index.set(name, i);
  });
  const missing = REQUIRED.filter((h) => !index.has(h));
  if (missing.length) throw new ParseError("import_missing_columns", `WeChat statement: missing columns ${missing.join(", ")}`, { columns: missing.join(", ") });

  const warnings: Notice[] = [];
  const rows: NormalizedRow[] = [];
  for (let i = headerAt + 1; i < grid.length; i++) {
    const cells = grid[i]!;
    if (!isDataRow(cells[0])) break;
    const lineNo = rows.length + 1;
    const cellOf = (name: string) => cells[index.get(name) ?? -1];
    const get = (name: string) => clean(text(cellOf(name)));

    const raw: Record<string, string> = {};
    for (const [name, at] of index) raw[name] = text(cells[at]);

    const timeCell = cellOf("交易时间");
    const occurredAt = timeCell instanceof Date ? excelDateToIso(timeCell) : localTextToIso(get("交易时间"));
    const amountCell = cellOf("金额(元)");
    const magnitude = Math.abs(
      typeof amountCell === "number" ? numberToMinor(amountCell) : parseAmountMinor(get("金额(元)")),
    );

    const bucket = get("收/支");
    const type = get("交易类型");
    const description = get("商品");
    const isRefund = type.endsWith("-退款");

    let direction: NormalizedRow["direction"];
    let kind: NormalizedRow["kind"];
    let sign: 1 | -1;
    if (bucket === "支出") {
      direction = "out";
      kind = "expense";
      sign = -1;
    } else if (bucket === "收入") {
      direction = "in";
      kind = "income";
      sign = 1;
    } else {
      if (bucket !== "/") warnings.push(unknownBucket(lineNo, bucket));
      direction = "neutral";
      kind = "transfer";
      const s = isRefund ? 1 : neutralSign(`${type} ${description}`);
      if (s === null) warnings.push(neutralDirectionUnknown(lineNo));
      sign = s ?? -1;
    }
    if (isRefund) {
      kind = "refund";
      sign = 1;
    }

    const paymentMethod = get("支付方式");
    rows.push({
      source: "wechat",
      lineNo,
      externalId: get("交易单号") || null,
      occurredAt,
      amountMinor: sign * magnitude,
      currency: "CNY",
      originalAmountMinor: null,
      originalCurrency: null,
      direction,
      kind,
      status: "ok",
      counterparty: get("交易对方"),
      description,
      sourceCategory: type || null,
      paymentMethod: paymentMethod === "" || paymentMethod === "/" ? null : paymentMethod,
      raw,
    });
  }

  if (declared.count !== undefined && declared.count !== rows.length) {
    warnings.push(countMismatch(declared.count, rows.length));
  }
  return { source: "wechat", rows, declared, periodStart, periodEnd, warnings };
}
