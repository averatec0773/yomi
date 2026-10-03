import type { TransactionItem } from "@yomi/contracts";
import { describe, expect, it } from "vitest";
import { isOn, myShareOf, splitStateOf, toggledSplits, withSplits } from "./split-math";

const SELF = 1;
const names: Record<number, string> = { 1: "我", 2: "室友", 3: "小李" };
const nameOf = (id: number) => names[id] ?? `#${id}`;

function tx(over: Partial<TransactionItem> = {}): TransactionItem {
  return {
    id: 1,
    occurredAt: "2026-09-28T12:00:00+08:00",
    occurredOn: "2026-09-27",
    amountMinor: -1001,
    currency: "CNY",
    originalAmountMinor: null,
    originalCurrency: null,
    kind: "expense",
    status: "ok",
    merchant: "瑞幸咖啡",
    counterpartyRaw: "",
    description: "",
    sourceCategory: null,
    note: null,
    categoryId: null,
    categoryName: null,
    accountId: 1,
    accountName: "支付宝",
    source: "alipay",
    importBatchId: null,
    duplicateOfId: null,
    userEditedAt: null,
    provisional: null,
    capture: null,
    splits: [],
    myShareMinor: 1001,
    suggestedParticipantIds: [],
    suggestion: null,
    ...over,
  };
}

describe("optimistic split math", () => {
  it("first tap splits equally with me, remainder to me", () => {
    const t = withSplits(tx(), toggledSplits(tx(), 2, SELF, nameOf));
    expect(t.splits.map((s) => [s.participantId, s.owedMinor, s.paidMinor])).toEqual([
      [1, 501, 1001],
      [2, 500, 0],
    ]);
    expect(t.myShareMinor).toBe(501);
    expect(isOn(t, 2)).toBe(true);
    expect(splitStateOf(t, SELF)?.mode).toBe("equal");
  });

  it("second participant re-splits, tapping everyone off clears", () => {
    let t = withSplits(tx(), toggledSplits(tx(), 2, SELF, nameOf));
    t = withSplits(t, toggledSplits(t, 3, SELF, nameOf));
    expect(t.myShareMinor).toBe(335);
    t = withSplits(t, toggledSplits(t, 2, SELF, nameOf));
    t = withSplits(t, toggledSplits(t, 3, SELF, nameOf));
    expect(t.splits).toEqual([]);
    expect(t.myShareMinor).toBe(1001);
  });

  it("full mode stays full and transfers count nothing", () => {
    const full = tx({
      splits: [
        { participantId: 1, name: "我", isSelf: true, owedMinor: 0, paidMinor: 1001 },
        { participantId: 2, name: "室友", isSelf: false, owedMinor: 1001, paidMinor: 0 },
      ],
    });
    expect(splitStateOf(full, SELF)?.mode).toBe("full");
    const t = withSplits(full, toggledSplits(full, 3, SELF, nameOf));
    expect(t.splits.find((s) => s.isSelf)?.owedMinor).toBe(0);
    expect(myShareOf({ ...t, kind: "transfer" }, t.splits)).toBe(0);
  });
});
