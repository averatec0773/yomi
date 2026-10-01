import { describe, expect, it } from "vitest";
import { mergeShortcuts, SetShortcutsInput, SHORTCUT_DEFAULTS, shortcutOverrides, shortcutProblems } from "./shortcuts";

describe("mergeShortcuts", () => {
  it("applies overrides on the defaults and ignores unknown actions, bad keys and a cleared leader", () => {
    expect(mergeShortcuts(undefined)).toEqual(SHORTCUT_DEFAULTS);
    expect(mergeShortcuts("garbage")).toEqual(SHORTCUT_DEFAULTS);
    const b = mergeShortcuts({ leader: ";", goAssets: "z", listNote: "", nope: "q", goStats: 5, goTools: "ab", goSplit: " " });
    expect(b.leader).toBe(";");
    expect(b.goAssets).toBe("z");
    expect(b.listNote).toBe("");
    expect(b.goStats).toBe("m");
    expect(b.goTools).toBe("o");
    expect(b.goSplit).toBe("s");
    expect(mergeShortcuts({ leader: "" }).leader).toBe("\\");
  });

  it("keeps only differences when turning bindings back into overrides", () => {
    expect(shortcutOverrides(mergeShortcuts({}))).toEqual({});
    expect(shortcutOverrides({ ...SHORTCUT_DEFAULTS, leader: ";", goStats: "m", listNote: "" })).toEqual({ leader: ";", listNote: "" });
  });
});

describe("shortcutProblems", () => {
  it("is empty for the defaults", () => {
    expect(shortcutProblems(mergeShortcuts({}))).toEqual({});
  });

  it("flags two actions on one key in the same scope, both ways", () => {
    expect(shortcutProblems(mergeShortcuts({ goStats: "t" }))).toEqual({
      goTransactions: { code: "conflict", with: "goStats" },
      goStats: { code: "conflict", with: "goTransactions" },
    });
    // The leader shares the top scope with the list keys and the global keys.
    expect(shortcutProblems(mergeShortcuts({ leader: "j" }))).toMatchObject({ leader: { code: "conflict", with: "listNext" } });
    expect(shortcutProblems(mergeShortcuts({ leader: "?" }))).toMatchObject({ help: { code: "conflict", with: "leader" } });
  });

  it("does not mix scopes: a nav key may equal a list key", () => {
    // goAssets "a" and listSplit "a" are the defaults.
    expect(shortcutProblems(mergeShortcuts({ goTransactions: "j" }))).toEqual({});
  });

  it("flags cleared required keys and unusable keys; cleared optional keys are fine", () => {
    const bindings = { ...SHORTCUT_DEFAULTS, leader: "", goRules: "Tab", listNote: "" };
    expect(shortcutProblems(bindings)).toEqual({ leader: { code: "required" }, goRules: { code: "unusable" } });
  });
});

describe("SetShortcutsInput", () => {
  it("accepts single printable keys and empty strings, refuses the rest", () => {
    expect(SetShortcutsInput.safeParse({ overrides: { leader: "\\", listNote: "" } }).success).toBe(true);
    for (const key of [" ", "\t", "Enter", "ab", "é"]) {
      expect(SetShortcutsInput.safeParse({ overrides: { leader: key } }).success).toBe(false);
    }
    expect(SetShortcutsInput.safeParse({ overrides: { unknown: "q" } }).success).toBe(false);
  });
});
