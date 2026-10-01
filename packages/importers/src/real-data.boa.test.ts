import { existsSync, readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parseBoaCsv } from "./boa";
import { detectSource } from "./index";
import { bucketTotals } from "./util/reconcile";

// Optional: runs when data/raw/BOA holds your own checking CSV exports (data/ is gitignored). Asserts aggregates, never
// prints row content.
const boaDir = fileURLToPath(new URL("../../../data/raw/BOA", import.meta.url));

// Bank of America names checking downloads stmt.csv (stmt (1).csv and so on for later ones).
const files = existsSync(boaDir) ? readdirSync(boaDir).filter((n) => /^stmt.*\.csv$/i.test(n)) : [];

describe.skipIf(files.length === 0)("BoA checking CSV real data", () => {
  it.each(files)("%s reconciles with the summary and the balances", (name) => {
    const bytes = new Uint8Array(readFileSync(`${boaDir}/${name}`));
    expect(detectSource(bytes, name)).toBe("boa_csv");
    const result = parseBoaCsv(bytes);
    expect(result.rows.length).toBeGreaterThan(0);
    // No warnings means the beginning + Σ = ending balance check passed.
    expect(result.warnings).toEqual([]);
    const parsed = bucketTotals(result.rows);
    expect(result.declared.income).toBeDefined();
    expect(result.declared.expense).toBeDefined();
    expect(parsed.income).toEqual(result.declared.income);
    expect(parsed.expense).toEqual(result.declared.expense);
    for (const r of result.rows) {
      expect(r.occurredAt).toMatch(/^\d{4}-\d{2}-\d{2}T12:00:00-05:00$/);
      expect(Number.isSafeInteger(r.amountMinor)).toBe(true);
    }
  });
});
