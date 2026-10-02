import { IbkrTestResult } from "@yomi/contracts";
import { describe, expect, it } from "vitest";
import { en } from "../../i18n/en";
import { zhCN } from "../../i18n/zh-CN";
import { missingSectionNotes } from "./ibkr-sections";

const ids = IbkrTestResult.shape.sections.element.shape.id.options;
const all = (missing: string[] = []) => ids.map((id) => ({ id, present: !missing.includes(id) }));

describe("IBKR test connection: sections", () => {
  it("says nothing more when all six sections are there", () => {
    expect(ids).toEqual(["accountInformation", "openPositions", "cashReport", "trades", "cashTransactions", "nav"]);
    expect(missingSectionNotes(all(), en)).toBeNull();
  });

  it("names each missing section with what yomi will lack, in reading order", () => {
    expect(missingSectionNotes(all(["nav", "trades"]), en)).toEqual([
      { id: "trades", name: "Trades", effect: "buys and sells in recent activity and on the chart" },
      { id: "nav", name: "Net Asset Value (NAV) in Base", effect: "earlier history: the investment chart starts on the first sync day instead of up to 365 days back" },
    ]);
  });

  it("has a name and an effect for every section in both languages", () => {
    for (const t of [en, zhCN]) {
      const notes = missingSectionNotes(all([...ids]), t)!;
      expect(notes).toHaveLength(6);
      for (const n of notes) expect([n.name.length > 0, n.effect.length > 0]).toEqual([true, true]);
    }
  });
});
