import { existsSync, readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { extractItems, parseIcbcItems } from "./icbc-pdf";

// Optional: runs when data/raw/ICBC holds your own PDF export (data/ is gitignored). Asserts aggregates, never prints row content.
const dataRaw = fileURLToPath(new URL("../../../data/raw", import.meta.url));
const icbcDir = `${dataRaw}/ICBC`;

describe.skipIf(!existsSync(dataRaw))("ICBC PDF real data", () => {
  const file = (existsSync(icbcDir) ? readdirSync(icbcDir) : []).find((n) => n.toLowerCase().endsWith(".pdf"));

  it("parses and reconciles every page with its declared totals", async () => {
    expect(file).toBeDefined();
    const pages = await extractItems(new Uint8Array(readFileSync(`${icbcDir}/${file}`)));
    const result = parseIcbcItems(pages);
    const { rows, declared } = result;

    expect(result.warnings).toEqual([]);
    expect(rows.length).toBeGreaterThan(0);
    expect(declared.count).toBe(rows.length);

    const out = rows.filter((r) => r.direction === "out");
    const inn = rows.filter((r) => r.direction === "in");
    expect(out.length + inn.length).toBe(rows.length);
    expect(declared.expense).toEqual({ count: out.length, minor: out.reduce((s, r) => s - r.amountMinor, 0) });
    expect(declared.income).toEqual({ count: inn.length, minor: inn.reduce((s, r) => s + r.amountMinor, 0) });

    let perPageRows = 0;
    for (const page of pages) {
      const p = parseIcbcItems([page]);
      expect(p.warnings).toEqual([]);
      expect(p.rows.length).toBe(p.declared.count);
      const pOut = p.rows.filter((r) => r.direction === "out").reduce((s, r) => s - r.amountMinor, 0);
      const pIn = p.rows.filter((r) => r.direction === "in").reduce((s, r) => s + r.amountMinor, 0);
      expect(pOut).toBe(p.declared.expense?.minor);
      expect(pIn).toBe(p.declared.income?.minor);
      perPageRows += p.rows.length;
    }
    expect(perPageRows).toBe(rows.length);

    // Count offenders instead of asserting per row, so a failure never prints row content.
    const bad = rows.filter(
      (r) =>
        !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\+08:00$/.test(r.occurredAt) ||
        !Number.isInteger(r.amountMinor) ||
        r.amountMinor === 0 ||
        !/^[A-Z]{3}$/.test(r.currency) ||
        r.counterparty === "" ||
        !/^工商银行信用卡\(\d{4}\)$/.test(r.paymentMethod ?? "") ||
        r.raw["交易卡号"] !== `****${r.paymentMethod?.slice(-5, -1)}`,
    );
    expect(bad.length).toBe(0);
    expect(result.periodStart).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(result.periodEnd! >= result.periodStart!).toBe(true);
  });
});
