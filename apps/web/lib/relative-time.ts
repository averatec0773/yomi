import type { Locale } from "@/i18n/config";

/**
 * How long ago `iso` was, for "Synced {time}": `justNow` under a minute, then minutes, hours and days
 * ("5 minutes ago", "yesterday", "3 天前"), and the short date from a week on ("Sep 20", "9月20日").
 */
export function relativeTime(iso: string, locale: Locale, justNow: string, now: number = Date.now()): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return iso;
  const s = Math.max(0, Math.round((now - t) / 1000));
  if (s < 60) return justNow;
  const rtf = new Intl.RelativeTimeFormat(locale, { numeric: "auto" });
  const m = Math.floor(s / 60);
  if (m < 60) return rtf.format(-m, "minute");
  const h = Math.floor(m / 60);
  if (h < 24) return rtf.format(-h, "hour");
  const d = Math.floor(h / 24);
  if (d < 7) return rtf.format(-d, "day");
  return new Intl.DateTimeFormat(locale, { month: "short", day: "numeric" }).format(new Date(t));
}
