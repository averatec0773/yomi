import { IbkrSectionItem } from "@yomi/contracts";
import { describe, expect, it } from "vitest";
import { en } from "../../i18n/en";
import { zhCN } from "../../i18n/zh-CN";
import { missingSectionNotes, unknownSectionNames } from "./ibkr-sections";

const ids = IbkrSectionItem.shape.id.options;
type State = IbkrSectionItem["state"];
const all = (states: Partial<Record<(typeof ids)[number], State>> = {}) => ids.map((id) => ({ id, state: states[id] ?? ("present" as State) }));

describe("IBKR Flex sections", () => {
  it("says nothing more when all six sections are there", () => {
    expect(ids).toEqual(["accountInformation", "openPositions", "cashReport", "trades", "cashTransactions", "nav"]);
    expect(missingSectionNotes(all(), en)).toBeNull();
    expect(unknownSectionNames(all(), en)).toEqual([]);
  });

  it("names each missing section with what yomi will lack, in reading order", () => {
    expect(missingSectionNotes(all({ nav: "missing", trades: "missing" }), en)).toEqual([
      { id: "trades", name: "Trades", effect: "buys and sells in recent activity and on the chart" },
      { id: "nav", name: "Net Asset Value (NAV) in Base", effect: "earlier history: the investment chart starts on the first sync day instead of up to 365 days back" },
    ]);
  });

  it("does not call a section missing when the pulls cannot tell", () => {
    const s = all({ trades: "unknown", cashTransactions: "unknown" });
    expect(missingSectionNotes(s, en)).toBeNull();
    expect(unknownSectionNames(s, en)).toEqual(["Trades", "Cash Transactions"]);
  });

  it("has a name and an effect for every section in both languages", () => {
    for (const t of [en, zhCN]) {
      const notes = missingSectionNotes(all(Object.fromEntries(ids.map((id) => [id, "missing"]))), t)!;
      expect(notes).toHaveLength(6);
      for (const n of notes) expect([n.name.length > 0, n.effect.length > 0]).toEqual([true, true]);
    }
  });
});
