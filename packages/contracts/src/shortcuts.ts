import { z } from "zod";

/**
 * Configurable keyboard shortcuts. The defaults live here and only; a user's stored value holds overrides alone
 * (user_settings key `shortcuts`, one JSON object). `scope` decides which bindings may not share a key:
 * `nav` keys are pressed after the leader, every `top` key (the leader included) is pressed on its own.
 * ⌘K, Esc, Shift + select, arrows and 1–9 in the split popover are fixed and not listed.
 */
export const SHORTCUT_DEFAULTS = {
  leader: "\\",
  goTransactions: "t",
  goStats: "m",
  goAssets: "a",
  goTools: "o",
  goSplit: "s",
  goImport: "i",
  goRules: "r",
  goSettings: ",",
  search: "/",
  help: "?",
  listNext: "j",
  listPrev: "k",
  listSelect: "x",
  listSplit: "a",
  listSplitAlt: "e",
  listCategory: "c",
  listNote: "n",
} as const;

export type ShortcutAction = keyof typeof SHORTCUT_DEFAULTS;
export type ShortcutScope = "top" | "nav";
/** One key per action; "" means the action has no key. */
export type ShortcutBindings = Record<ShortcutAction, string>;

export const SHORTCUT_ACTIONS = Object.keys(SHORTCUT_DEFAULTS) as ShortcutAction[];

export function shortcutScope(action: ShortcutAction): ShortcutScope {
  return action.startsWith("go") ? "nav" : "top";
}

/** Actions that must keep a key (Backspace does not clear them). */
export function isClearable(action: ShortcutAction): boolean {
  return action !== "leader";
}

/** A bindable key: one printable ASCII character other than space. Tab, Enter, Space and modifiers are never keys here. */
export function isUsableKey(key: string): boolean {
  return /^[\x21-\x7e]$/.test(key);
}

export const ShortcutActionSchema = z.enum(SHORTCUT_ACTIONS as [ShortcutAction, ...ShortcutAction[]]);

/** Stored and sent value: overrides only. */
export const ShortcutOverrides = z.partialRecord(ShortcutActionSchema, z.string().max(1).refine((k) => k === "" || isUsableKey(k), "unusable key"));
export type ShortcutOverrides = z.infer<typeof ShortcutOverrides>;

/** PUT /api/settings/shortcuts body; the response is the stored overrides. `{}` resets to the defaults. */
export const SetShortcutsInput = z.object({ overrides: ShortcutOverrides });
export type SetShortcutsInput = z.infer<typeof SetShortcutsInput>;

/** GET/PUT /api/settings/shortcuts. */
export const ShortcutsSetting = z.object({ overrides: ShortcutOverrides });
export type ShortcutsSetting = z.infer<typeof ShortcutsSetting>;

/** Defaults with the overrides applied. Unknown actions and unusable keys in the stored value are ignored. */
export function mergeShortcuts(overrides: unknown): ShortcutBindings {
  const out: ShortcutBindings = { ...SHORTCUT_DEFAULTS };
  if (!overrides || typeof overrides !== "object") return out;
  for (const [action, key] of Object.entries(overrides)) {
    if (!(action in SHORTCUT_DEFAULTS) || typeof key !== "string") continue;
    const a = action as ShortcutAction;
    if (key === "" ? isClearable(a) : isUsableKey(key)) out[a] = key;
  }
  return out;
}

/** Only the bindings that differ from the defaults, in action order. */
export function shortcutOverrides(bindings: ShortcutBindings): ShortcutOverrides {
  const out: ShortcutOverrides = {};
  for (const a of SHORTCUT_ACTIONS) if (bindings[a] !== SHORTCUT_DEFAULTS[a]) out[a] = bindings[a];
  return out;
}

export type ShortcutProblem = { code: "conflict"; with: ShortcutAction } | { code: "unusable" } | { code: "required" };

/** Per action, what is wrong with its key: another action in the same scope has it, it cannot be used, or it is empty but must be set. */
export function shortcutProblems(bindings: ShortcutBindings): Partial<Record<ShortcutAction, ShortcutProblem>> {
  const out: Partial<Record<ShortcutAction, ShortcutProblem>> = {};
  for (const a of SHORTCUT_ACTIONS) {
    const key = bindings[a];
    if (key === "") {
      if (!isClearable(a)) out[a] = { code: "required" };
      continue;
    }
    if (!isUsableKey(key)) {
      out[a] = { code: "unusable" };
      continue;
    }
    const other = SHORTCUT_ACTIONS.find((b) => b !== a && shortcutScope(b) === shortcutScope(a) && bindings[b] === key);
    if (other) out[a] = { code: "conflict", with: other };
  }
  return out;
}
