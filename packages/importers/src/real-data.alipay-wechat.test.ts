// Optional: parses your own exports under data/raw/alipay and data/raw/wechat (gitignored). Skipped when absent.
// Asserts only; never prints row content.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parseAlipay } from "./alipay";
import type { ParseResult } from "./types";
import { bucketTotals } from "./util/reconcile";
import { parseWechat } from "./wechat";

const rawDir = fileURLToPath(new URL("../../../data/raw", import.meta.url));

function files(sub: string, ext: string): string[] {
  const dir = `${rawDir}/${sub}`;
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.toLowerCase().endsWith(ext))
    .map((f) => `${dir}/${f}`);
}

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\+08:00$/;

function checkResult(result: ParseResult) {
  expect(result.warnings.length).toBe(0);
  expect(result.declared.count).toBe(result.rows.length);
  expect(bucketTotals(result.rows)).toEqual(result.declared);
  const ids = new Set<string>();
  for (const row of result.rows) {
    expect(typeof row.externalId === "string" && row.externalId.length > 0).toBe(true);
    ids.add(row.externalId!);
    expect(ISO.test(row.occurredAt) && !Number.isNaN(Date.parse(row.occurredAt))).toBe(true);
    expect(Number.isSafeInteger(row.amountMinor)).toBe(true);
  }
  expect(ids.size).toBe(result.rows.length);
}

describe.skipIf(!existsSync(rawDir))("real exports reconcile with their declared totals", () => {
  it("alipay", () => {
    const list = files("alipay", ".csv");
    expect(list.length).toBeGreaterThan(0);
    for (const f of list) checkResult(parseAlipay(readFileSync(f)));
  });

  it("wechat", async () => {
    const list = files("wechat", ".xlsx");
    expect(list.length).toBeGreaterThan(0);
    for (const f of list) checkResult(await parseWechat(readFileSync(f), f));
  });
});
