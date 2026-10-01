/** Supported UI locales. English is the default; the `locale` cookie switches it. Pure, server and client. */
export const LOCALES = ["en", "zh-CN"] as const;
export type Locale = (typeof LOCALES)[number];
export const DEFAULT_LOCALE: Locale = "en";
export const LOCALE_COOKIE = "locale";

export function toLocale(value: string | null | undefined): Locale {
  return LOCALES.find((l) => l === value) ?? DEFAULT_LOCALE;
}
