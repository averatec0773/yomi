"use client";

import { createContext, type ReactNode, use } from "react";
import { DEFAULT_LOCALE, LOCALE_COOKIE, type Locale } from "./config";
import { type Dictionary, en } from "./en";
import { getDictionary } from "./index";

const I18nContext = createContext<{ locale: Locale; t: Dictionary }>({ locale: DEFAULT_LOCALE, t: en });

// For code outside React (apiFetch toasts). The provider keeps it in step with the rendered locale.
let current: Dictionary = en;

export function getClientDictionary(): Dictionary {
  return current;
}

/**
 * Mounted once in the root layout with the request's locale. Both dictionaries come from the client bundle (one cached
 * chunk), so neither is serialized into every page and router refresh.
 */
export function I18nProvider({ locale, children }: { locale: Locale; children: ReactNode }) {
  const t = getDictionary(locale);
  current = t;
  return <I18nContext value={{ locale, t }}>{children}</I18nContext>;
}

/** The active dictionary in client components. */
export function useT(): Dictionary {
  return use(I18nContext).t;
}

export function useLocale(): Locale {
  return use(I18nContext).locale;
}

/** Stores the choice for a year; the caller refreshes the router so server components re-render. */
export function writeLocaleCookie(locale: Locale): void {
  document.cookie = `${LOCALE_COOKIE}=${locale}; path=/; max-age=31536000; samesite=lax`;
}
