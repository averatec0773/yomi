import { DEFAULT_STATEMENT_FLAGS, type StatementFlag, type StatementScope } from "@yomi/contracts";
import { type Dictionary, fmt, plural } from "../../i18n";

/** The print view's header line for a statement scope: "Open items only", "All items", "Selected 2 items". */
export function scopeHeading(p: Dictionary["split"]["print"], scope: StatementScope, count: number): string {
  if (scope === "selected") return plural(p.scopeSelected, count);
  return scope === "all" ? p.scopeAll : p.scopeOpen;
}

const FLAG_ORDER: readonly StatementFlag[] = ["shared", "names", "myshare", "notes", "settlements", "category", "payment"];

/** Known flags in canonical order; "names" brings "shared" with it (same rule as core). */
export function normalizeFlags(flags: readonly string[]): StatementFlag[] {
  const set = new Set(flags);
  if (set.has("names")) set.add("shared");
  return FLAG_ORDER.filter((f) => set.has(f));
}

/** Turns one option on or off; turning "shared" off also turns "names" off. */
export function toggleFlag(flags: readonly StatementFlag[], flag: StatementFlag): StatementFlag[] {
  const set = new Set(flags);
  if (set.has(flag)) {
    set.delete(flag);
    if (flag === "shared") set.delete("names");
  } else set.add(flag);
  return normalizeFlags([...set]);
}

/** Query fragment for the options: "&show=shared,notes" (an empty value shows none of them). */
export function showQuery(flags: readonly StatementFlag[]): string {
  return `&show=${normalizeFlags(flags).join(",")}`;
}

const storageKey = (participantId: number) => `yomi.statement.show.${participantId}`;
/**
 * "Payment details" is remembered on its own key, and only when turned off: options saved before it existed carry no
 * "payment", and it should still be on for them.
 */
const paymentKey = (participantId: number) => `yomi.statement.pay.${participantId}`;

/** The options last used for this person, or the defaults. */
export function loadFlags(participantId: number): StatementFlag[] {
  let flags: string[] = [...DEFAULT_STATEMENT_FLAGS];
  let payment = true;
  try {
    const raw = localStorage.getItem(storageKey(participantId));
    if (raw !== null) {
      const parsed: unknown = JSON.parse(raw);
      if (Array.isArray(parsed)) flags = parsed.filter((f): f is string => typeof f === "string");
    }
    payment = localStorage.getItem(paymentKey(participantId)) !== "off";
  } catch {
    /* private mode or a bad value: defaults */
  }
  return normalizeFlags([...flags.filter((f) => f !== "payment"), ...(payment ? ["payment"] : [])]);
}

export function saveFlags(participantId: number, flags: readonly StatementFlag[]): void {
  try {
    localStorage.setItem(storageKey(participantId), JSON.stringify(flags));
    if (flags.includes("payment")) localStorage.removeItem(paymentKey(participantId));
    else localStorage.setItem(paymentKey(participantId), "off");
  } catch {
    /* private mode: the options just do not persist */
  }
}

const colorsKey = (participantId: number) => `yomi.statement.colors.${participantId}`;

/**
 * "Print on white paper" for this person's printed statement. Off by default: the printed page matches the preview
 * (the app theme, backgrounds included). A display option, not a `show` flag.
 */
export function loadWhitePaper(participantId: number): boolean {
  try {
    return localStorage.getItem(colorsKey(participantId)) === "light";
  } catch {
    return false;
  }
}

export function saveWhitePaper(participantId: number, on: boolean): void {
  try {
    if (on) localStorage.setItem(colorsKey(participantId), "light");
    else localStorage.removeItem(colorsKey(participantId));
  } catch {
    /* private mode: the option just does not persist */
  }
}

/** Query fragment for the print view's paper: "&colors=light" for white paper, nothing for the screen colors. */
export function colorsQuery(whitePaper: boolean): string {
  return whitePaper ? "&colors=light" : "";
}

/** The share column label: "Sam's share" once a display name is set, else "My share". */
export function myShareLabel(p: Dictionary["split"]["print"], myName: string | null | undefined): string {
  return myName ? fmt(p.nameShare, { name: myName }) : p.myShare;
}

/** A CSS string literal for `content:`; `<` is escaped so the text cannot close the inline <style>. */
export function cssString(text: string): string {
  return `"${text.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/</g, "\\3C ").replace(/\r?\n/g, "\\A ")}"`;
}

/** "Page {page} of {pages}" as a CSS `content` value with the page counters in place of the placeholders. */
export function pageOfContent(template: string): string {
  return template
    .split(/(\{page\}|\{pages\})/)
    .filter(Boolean)
    .map((part) => (part === "{page}" ? "counter(page)" : part === "{pages}" ? "counter(pages)" : cssString(part)))
    .join(" ");
}

/** "Split 3 ways" or "Split 3 ways (with Li, Sam)"; empty when only me and the recipient share the item. */
export function splitWaysLabel(
  p: Dictionary["split"]["print"],
  item: { splitCount: number; sharedWith: readonly string[] },
  flags: readonly StatementFlag[],
): string {
  if (!flags.includes("shared") || item.sharedWith.length === 0) return "";
  return flags.includes("names")
    ? fmt(p.splitWaysWith, { count: item.splitCount, names: item.sharedWith.join(p.nameSeparator) })
    : fmt(p.splitWays, { count: item.splitCount });
}

export type SharedMode = "count" | "names" | "hidden";

/** The "Who shared" choice the flags express. */
export function sharedMode(flags: readonly StatementFlag[]): SharedMode {
  if (flags.includes("names")) return "names";
  return flags.includes("shared") ? "count" : "hidden";
}

/** The flags with "Who shared" set to `mode` (count: shared; names: shared + names; hidden: neither). */
export function withSharedMode(flags: readonly StatementFlag[], mode: SharedMode): StatementFlag[] {
  const rest: StatementFlag[] = flags.filter((f) => f !== "shared" && f !== "names");
  if (mode === "count") rest.push("shared");
  if (mode === "names") rest.push("shared", "names");
  return normalizeFlags(rest);
}

/** The item row's "Split 3 ways" or "Split 3 ways with Li"; empty when "Who shared" is hidden or nobody else shares it. */
export function rowSplitLabel(
  st: Dictionary["split"]["statement"],
  p: Dictionary["split"]["print"],
  item: { splitCount: number; sharedWith: readonly string[] },
  flags: readonly StatementFlag[],
): string {
  if (!flags.includes("shared") || item.sharedWith.length === 0) return "";
  return flags.includes("names")
    ? fmt(st.rowSplitWith, { count: item.splitCount, names: item.sharedWith.join(p.nameSeparator) })
    : fmt(p.splitWays, { count: item.splitCount });
}

const OPTIONS_OPEN_KEY = "yomi.statement.optionsOpen";

/** Whether the statement's Options panel was left open (collapsed by default). */
export function loadOptionsOpen(): boolean {
  try {
    return localStorage.getItem(OPTIONS_OPEN_KEY) === "1";
  } catch {
    return false;
  }
}

export function saveOptionsOpen(open: boolean): void {
  try {
    localStorage.setItem(OPTIONS_OPEN_KEY, open ? "1" : "0");
  } catch {
    /* private mode: the panel just starts collapsed */
  }
}

/**
 * The file name for "Save as image": `yomi-statement-<person>-<currency>-<YYYY-MM-DD>.png`. The person is the name as a
 * slug (lowercase letters and digits of any script, CJK kept as is, runs of anything else as one "-"), or
 * `person-<id>` when nothing is left of it.
 */
export function statementImageName(name: string, participantId: number, currency: string, date: string): string {
  const slug = name
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60)
    .replace(/-+$/, "");
  return `yomi-statement-${slug || `person-${participantId}`}-${currency}-${date}.png`;
}

/** Everyone besides me and the recipient who shares any of the items, in first-seen order. */
export function othersIn(items: readonly { sharedWith: readonly string[] }[]): string[] {
  return [...new Set(items.flatMap((i) => i.sharedWith))];
}
