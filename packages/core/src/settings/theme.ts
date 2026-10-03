import type { Db } from "@yomi/db";
import type { CurrentUser } from "../user";
import { deleteSetting, readSetting, writeSetting } from "./store";

const THEME_KEY = "theme";

export const THEMES = ["system", "light", "dark"] as const;
export type Theme = (typeof THEMES)[number];

export function isTheme(value: unknown): value is Theme {
  return typeof value === "string" && (THEMES as readonly string[]).includes(value);
}

/** The user's color theme; `system` (follow the OS) when nothing or an unknown value is stored. */
export async function getTheme(q: Db, user: CurrentUser): Promise<Theme> {
  const raw = await readSetting(q, user, THEME_KEY);
  return isTheme(raw) ? raw : "system";
}

/** Stores the theme; `system` removes the row (the default). */
export async function setTheme(q: Db, user: CurrentUser, theme: Theme): Promise<Theme> {
  if (theme === "system") await deleteSetting(q, user, THEME_KEY);
  else await writeSetting(q, user, THEME_KEY, theme);
  return await getTheme(q, user);
}
