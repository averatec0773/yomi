import type { Db } from "@yomi/db";
import type { CurrentUser } from "../user";
import { deleteSetting, readSetting, writeSetting } from "./store";

const SHORTCUTS_KEY = "shortcuts";

/**
 * The user's keyboard shortcut overrides (action → key), stored as one JSON object. The actions, defaults and
 * validation live in @yomi/contracts/shortcuts; core only keeps the string map. A value that is not a JSON object of
 * strings reads as no overrides.
 */
export async function getShortcutOverrides(q: Db, user: CurrentUser): Promise<Record<string, string>> {
  const raw = await readSetting(q, user, SHORTCUTS_KEY);
  if (!raw) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return Object.fromEntries(Object.entries(parsed).filter((e): e is [string, string] => typeof e[1] === "string"));
  } catch {
    return {};
  }
}

/** Replaces the stored overrides; an empty map removes the row (back to the defaults). */
export async function setShortcutOverrides(q: Db, user: CurrentUser, overrides: Record<string, string>): Promise<Record<string, string>> {
  if (Object.keys(overrides).length === 0) await deleteSetting(q, user, SHORTCUTS_KEY);
  else await writeSetting(q, user, SHORTCUTS_KEY, JSON.stringify(overrides));
  return await getShortcutOverrides(q, user);
}
