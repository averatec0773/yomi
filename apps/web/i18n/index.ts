import type { Locale } from "./config";
import { en } from "./en";
import { zhCN } from "./zh-CN";

export type { Dictionary } from "./en";
export { DEFAULT_LOCALE, LOCALE_COOKIE, LOCALES, type Locale, toLocale } from "./config";
export { fmt, type Plural, plural } from "./format";

const DICTIONARIES = { en, "zh-CN": zhCN } as const;

export function getDictionary(locale: Locale) {
  return DICTIONARIES[locale];
}
