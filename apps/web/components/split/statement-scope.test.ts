import { describe, expect, it } from "vitest";
import { getDictionary } from "../../i18n";
import {
  colorsQuery,
  cssString,
  loadFlags,
  myShareLabel,
  normalizeFlags,
  pageOfContent,
  othersIn,
  rowSplitLabel,
  saveFlags,
  scopeHeading,
  sharedMode,
  showQuery,
  splitWaysLabel,
  statementImageName,
  toggleFlag,
  withSharedMode,
} from "./statement-scope";

describe("scopeHeading", () => {
  it("states the scope in both locales", () => {
    const en = getDictionary("en").split.print;
    expect(scopeHeading(en, "open", 3)).toBe("Open items only");
    expect(scopeHeading(en, "all", 7)).toBe("All items");
    expect(scopeHeading(en, "selected", 1)).toBe("Selected 1 item");
    expect(scopeHeading(en, "selected", 2)).toBe("Selected 2 items");
    const zh = getDictionary("zh-CN").split.print;
    expect(scopeHeading(zh, "open", 3)).toBe("仅未结清账目");
    expect(scopeHeading(zh, "all", 7)).toBe("全部账目");
    expect(scopeHeading(zh, "selected", 2)).toBe("所选 2 笔");
  });
});

describe("statement options", () => {
  it("names brings shared; turning shared off drops names", () => {
    expect(toggleFlag(["shared", "notes"], "names")).toEqual(["shared", "names", "notes"]);
    expect(toggleFlag(["shared", "names", "notes"], "shared")).toEqual(["notes"]);
    expect(normalizeFlags(["category", "names", "bogus"])).toEqual(["shared", "names", "category"]);
    expect(showQuery([])).toBe("&show=");
    expect(showQuery(["settlements", "shared"])).toBe("&show=shared,settlements");
    expect(showQuery(["payment", "category", "notes"])).toBe("&show=notes,category,payment");
  });

  it("payment info is on by default, also for options saved before it existed, and remembered when off", () => {
    const store = new Map<string, string>();
    const local = {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k),
    };
    const prev = (globalThis as { localStorage?: unknown }).localStorage;
    (globalThis as { localStorage?: unknown }).localStorage = local;
    try {
      expect(loadFlags(7)).toEqual(["shared", "notes", "settlements", "payment"]);
      store.set("yomi.statement.show.7", JSON.stringify(["shared", "names", "notes"]));
      expect(loadFlags(7)).toEqual(["shared", "names", "notes", "payment"]);
      saveFlags(7, ["notes"]);
      expect(loadFlags(7)).toEqual(["notes"]);
      saveFlags(7, ["notes", "payment"]);
      expect(store.has("yomi.statement.pay.7")).toBe(false);
      expect(loadFlags(7)).toEqual(["notes", "payment"]);
    } finally {
      (globalThis as { localStorage?: unknown }).localStorage = prev;
    }
  });

  it("who shared reads the same in both languages as the text", () => {
    const item = { splitCount: 3, sharedWith: ["Li", "Sam"] };
    const en = getDictionary("en").split.print;
    const zh = getDictionary("zh-CN").split.print;
    expect(splitWaysLabel(en, item, ["shared"])).toBe("Split 3 ways");
    expect(splitWaysLabel(en, item, ["shared", "names"])).toBe("Split 3 ways (with Li, Sam)");
    expect(splitWaysLabel(zh, item, ["shared"])).toBe("3 人分摊");
    expect(splitWaysLabel(zh, item, ["shared", "names"])).toBe("3 人分摊（和 Li、Sam）");
    expect(splitWaysLabel(en, item, ["notes"])).toBe("");
    expect(splitWaysLabel(en, { splitCount: 2, sharedWith: [] }, ["shared", "names"])).toBe("");
    expect(othersIn([item, { sharedWith: ["Sam", "Jo"] }])).toEqual(["Li", "Sam", "Jo"]);
  });

  it("who shared is one choice: count only, names or hidden", () => {
    expect(sharedMode([])).toBe("hidden");
    expect(sharedMode(["shared", "notes"])).toBe("count");
    expect(sharedMode(["shared", "names"])).toBe("names");
    expect(withSharedMode(["shared", "names", "notes"], "count")).toEqual(["shared", "notes"]);
    expect(withSharedMode(["notes"], "names")).toEqual(["shared", "names", "notes"]);
    expect(withSharedMode(["shared", "names", "category"], "hidden")).toEqual(["category"]);
  });

  it("print colors and the page footer's CSS content", () => {
    expect(colorsQuery(false)).toBe("");
    expect(colorsQuery(true)).toBe("&colors=light");
    expect(cssString('Shared with "Al" </style>')).toBe('"Shared with \\"Al\\" \\3C /style>"');
    expect(pageOfContent(getDictionary("en").split.print.pageOf)).toBe('"Page " counter(page) " of " counter(pages)');
    expect(pageOfContent(getDictionary("zh-CN").split.print.pageOf)).toBe('"第 " counter(page) " 页，共 " counter(pages) " 页"');
  });

  it("the share column carries the display name, falling back to My share", () => {
    const en = getDictionary("en").split.print;
    const zh = getDictionary("zh-CN").split.print;
    expect(myShareLabel(en, "Sam")).toBe("Sam's share");
    expect(myShareLabel(zh, "Sam")).toBe("Sam的份额");
    expect(myShareLabel(en, null)).toBe("My share");
    expect(myShareLabel(en, "")).toBe("My share");
    expect(myShareLabel(zh, undefined)).toBe("我的份额");
  });

  it("the item row names the others only when Names is on", () => {
    const item = { splitCount: 3, sharedWith: ["Li"] };
    const en = getDictionary("en").split;
    const zh = getDictionary("zh-CN").split;
    expect(rowSplitLabel(en.statement, en.print, item, ["shared"])).toBe("Split 3 ways");
    expect(rowSplitLabel(en.statement, en.print, item, ["shared", "names"])).toBe("Split 3 ways with Li");
    expect(rowSplitLabel(zh.statement, zh.print, item, ["shared", "names"])).toBe("3 人分摊，和 Li");
    expect(rowSplitLabel(en.statement, en.print, item, [])).toBe("");
  });

  it("names the saved image after the person, currency and day", () => {
    expect(statementImageName("Alexandra Whitfield", 2, "USD", "2026-09-30")).toBe("yomi-statement-alexandra-whitfield-USD-2026-09-30.png");
    expect(statementImageName("室友", 2, "USD", "2026-09-30")).toBe("yomi-statement-室友-USD-2026-09-30.png");
    expect(statementImageName("  O'Brien & Co. / 小李 ", 7, "CNY", "2026-09-30")).toBe("yomi-statement-o-brien-co-小李-CNY-2026-09-30.png");
    expect(statementImageName("Ｒｏｏｍｉｅ", 3, "USD", "2026-09-30")).toBe("yomi-statement-roomie-USD-2026-09-30.png");
    // Nothing usable left of the name: the participant id.
    expect(statementImageName("?? // !!", 5, "EUR", "2026-01-02")).toBe("yomi-statement-person-5-EUR-2026-01-02.png");
    expect(statementImageName("x".repeat(80), 1, "USD", "2026-09-30")).toBe(`yomi-statement-${"x".repeat(60)}-USD-2026-09-30.png`);
  });
});
