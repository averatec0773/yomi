"use client";

import { createContext, type ReactNode, use } from "react";
import { DEFAULT_LOCALE, LOCALE_COOKIE, type Locale } from "./config";
import { type Dictionary, en } from "./en";

const I18nContext = createContext<{ locale: Locale; t: Dictionary }>({ locale: DEFAULT_LOCALE, t: en });

// For code outside React (apiFetch toasts). The provider keeps it in step with the rendered locale.
let current: Dictionary = en;

export function getClientDictionary(): Dictionary {
  return current;
}

/** Mounted once in the root layout with the request's locale and dictionary. */
export function I18nProvider({ locale, t, children }: { locale: Locale; t: Dictionary; children: ReactNode }) {
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
