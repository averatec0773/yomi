import { createHash } from "node:crypto";
import type { NormalizedRow } from "@yomi/importers";

export function sha256Hex(data: string | Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

export function normalizeForDedup(counterparty: string, description: string): string {
  return `${counterparty} ${description}`.trim().toUpperCase().replace(/\s+/g, " ").slice(0, 40);
}

/**
 * One key per row, in order. Rows with an external id use it; the rest hash their content and
 * append the ordinal among identical hashes in this file, so two genuinely identical rows both survive.
 * A repeated external id inside one file also gets an ordinal suffix rather than colliding.
 * BoA checking rows carry a running balance, which tells identical same-day rows apart on its own: their
 * key is `boa_csv:h:<sha256(account|date|amount|running balance|raw description)>` with no ordinal, so it stays the
 * same in two downloads whose date ranges overlap differently (an ordinal only suffixes a repeat).
 */
export function computeDedupKeys(rows: readonly NormalizedRow[], accountKeys: readonly string[]): string[] {
  const seen = new Map<string, number>();
  return rows.map((row, i) => {
    let base: string;
    const runningBal = row.source === "boa_csv" ? (row.raw["Running Bal."] ?? "").trim() : "";
    if (row.externalId) {
      base = `${row.source}:${row.externalId}`;
    } else if (runningBal) {
      const content = [
        accountKeys[i] ?? "",
        row.occurredAt.slice(0, 10),
        String(row.amountMinor),
        runningBal.replace(/[$,\s]/g, ""),
        // Raw text only: the parsed counterparty would change the key whenever the description rules change.
        normalizeForDedup("", row.description),
      ].join("|");
      base = `${row.source}:h:${sha256Hex(content)}`;
    } else {
      const content = [
        accountKeys[i] ?? "",
        row.occurredAt,
        String(row.amountMinor),
        row.currency,
        normalizeForDedup(row.counterparty, row.description),
      ].join("|");
      base = `${row.source}:h:${sha256Hex(content)}`;
    }
    const n = seen.get(base) ?? 0;
    seen.set(base, n + 1);
    if (row.externalId || runningBal) return n === 0 ? base : `${base}:${n}`;
    return `${base}:${n}`;
  });
}
