import type { Locale } from "@/i18n/config";

/** Currency the statement is booked in, when the preview does not say (only spending rows carry one). */
export function statementCurrency(source: string, spending: { currency: string }[]): string | null {
  if (spending[0]) return spending[0].currency;
  if (source === "alipay" || source === "wechat") return "CNY";
  if (source === "boa_csv") return "USD";
  return null;
}

/** '2026-09-29T09:18:23.641Z' → 'Sep 29, 17:18' / '9月29日 17:18' in local time. */
export function shortDateTime(iso: string, locale: Locale): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  if (locale === "zh-CN") return `${d.getMonth() + 1}月${d.getDate()}日 ${hh}:${mm}`;
  return `${new Intl.DateTimeFormat(locale, { month: "short", day: "numeric" }).format(d)}, ${hh}:${mm}`;
}
