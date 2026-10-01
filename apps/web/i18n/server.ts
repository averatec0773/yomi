import "server-only";
import { cookies } from "next/headers";
import { cache } from "react";
import { LOCALE_COOKIE, toLocale } from "./config";
import { getDictionary } from "./index";

/** Locale and dictionary for the current request (from the `locale` cookie, default English). Server components only. */
export const getI18n = cache(async () => {
  const locale = toLocale((await cookies()).get(LOCALE_COOKIE)?.value);
  return { locale, t: getDictionary(locale) };
});
