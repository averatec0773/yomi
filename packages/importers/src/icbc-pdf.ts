import { extractItems } from "./icbc/extract";
import { parseIcbcItems } from "./icbc/parse";
import type { ParseResult } from "./types";

export { extractItems, parseIcbcItems };
export type { TextItem } from "./icbc/parse";

export async function parseIcbcPdf(bytes: Uint8Array): Promise<ParseResult> {
  return parseIcbcItems(await extractItems(bytes));
}
