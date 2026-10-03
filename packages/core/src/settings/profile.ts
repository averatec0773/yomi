import type { Db } from "@yomi/db";
import type { CurrentUser } from "../user";
import { deleteSetting, readSetting, writeSetting } from "./store";

const DISPLAY_NAME_KEY = "display_name";
export const DISPLAY_NAME_MAX = 40;

/** Trimmed, at most DISPLAY_NAME_MAX characters; empty means unset (null). */
export function normalizeDisplayName(value: string | null | undefined): string | null {
  const name = (value ?? "").trim().slice(0, DISPLAY_NAME_MAX).trim();
  return name === "" ? null : name;
}

/** The user's display name for statements ("Sam's share"), or null when unset. */
export async function getDisplayName(q: Db, user: CurrentUser): Promise<string | null> {
  return normalizeDisplayName(await readSetting(q, user, DISPLAY_NAME_KEY));
}

/** Stores the display name; an empty value removes the row. Returns what is stored now. */
export async function setDisplayName(q: Db, user: CurrentUser, value: string | null): Promise<string | null> {
  const name = normalizeDisplayName(value);
  if (name === null) await deleteSetting(q, user, DISPLAY_NAME_KEY);
  else await writeSetting(q, user, DISPLAY_NAME_KEY, name);
  return await getDisplayName(q, user);
}
