// Statement parsers: file bytes + file name in, normalized rows out. Never touches the DB.
import { parseAlipay } from "./alipay";
import { boaCsvVariant, parseBoaCsv } from "./boa";
import { parseIcbcPdf } from "./icbc-pdf";
import { parseWechat } from "./wechat";
import { ParseError } from "./errors";
import type { ParseResult, SourceId } from "./types";

export * from "./types";
export * from "./errors";
export { bucketTotals } from "./util/reconcile";
export { parseAlipay, parseBoaCsv, parseIcbcPdf, parseWechat };
export { parseIcbcItems, type TextItem } from "./icbc/parse";
export { BOA_CARD_METHOD, BOA_CHECKING_METHOD, boaCsvVariant, parseBoaDescription, zelleCounterparty } from "./boa";
export * from "./plaid";
export * from "./ibkr";
export * from "./invest";
export * from "./util/decimal";
export * from "./sms/icbc";

export function detectSource(bytes: Uint8Array, fileName: string): SourceId | null {
  const name = fileName.toLowerCase();
  if (name.endsWith(".pdf") || isPdf(bytes)) return "icbc_pdf";
  if (name.endsWith(".xlsx") || isZip(bytes)) return "wechat";
  if (isBoaCsv(bytes)) return "boa_csv";
  if (name.endsWith(".csv")) {
    if (startsWithUtf8Bom(bytes)) return "wechat";
    return "alipay";
  }
  return null;
}

export async function detectAndParse(bytes: Uint8Array, fileName: string): Promise<ParseResult> {
  const source = detectSource(bytes, fileName);
  switch (source) {
    case "alipay":
      return parseAlipay(bytes);
    case "wechat":
      return parseWechat(bytes, fileName);
    case "icbc_pdf":
      return parseIcbcPdf(bytes);
    case "boa_csv":
      return parseBoaCsv(bytes);
    default:
      throw new ParseError("import_unknown_format", `Unrecognized statement file: ${fileName}`, { fileName });
  }
}

function isPdf(b: Uint8Array): boolean {
  return b[0] === 0x25 && b[1] === 0x50 && b[2] === 0x44 && b[3] === 0x46;
}
function isZip(b: Uint8Array): boolean {
  return b[0] === 0x50 && b[1] === 0x4b;
}
function startsWithUtf8Bom(b: Uint8Array): boolean {
  return b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf;
}

/** BoA CSV by content: the first non-blank line is its summary or one of its two headers (ASCII, so latin1 is safe). */
function isBoaCsv(b: Uint8Array): boolean {
  const head = new TextDecoder("latin1").decode(b.subarray(0, 512)).replace(/^\u00ef\u00bb\u00bf/, "");
  const first = head.split(/\r?\n/).find((l) => l.trim() !== "");
  return first !== undefined && boaCsvVariant(first) !== null;
}
