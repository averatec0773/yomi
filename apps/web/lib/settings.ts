import "server-only";
import { getCurrentUser, getShortcutOverrides, getTheme, getTimeZoneSetting, todayIn } from "@yomi/core";
import { cache } from "react";
import { getDb } from "./db";

// Per-request reads of the user's settings (React cache): the root layout and the page share one query each.

/** The user's stored time zone (or the default, with isSet false). */
export const getZoneSetting = cache(async () => getTimeZoneSetting(await getDb(), getCurrentUser()));

/** Today's 'YYYY-MM-DD' in the user's time zone: the one "today" every page renders with. */
export const getToday = cache(async () => todayIn((await getZoneSetting()).timeZone));

export const getThemeSetting = cache(async () => getTheme(await getDb(), getCurrentUser()));

export const getShortcutSetting = cache(async () => getShortcutOverrides(await getDb(), getCurrentUser()));
