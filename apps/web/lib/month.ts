/** Month helpers on 'YYYY-MM' strings. Pure, usable on server and client. */

import { clockNow } from "@yomi/core/time";
import type { Locale } from "../i18n/config";

const MONTH_RE = /^(\d{4})-(0[1-9]|1[0-2])$/;

export function isMonth(value: unknown): value is string {
  return typeof value === "string" && MONTH_RE.test(value);
}

/** Current month in the viewer's local time (server: the server's local time). */
export function currentMonth(now = clockNow()): string {
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
}

/** 'YYYY-MM-DD' (or 'YYYY-MM') as a UTC Date, so formatting never shifts the day. */
export function utcDate(iso: string): Date {
  const [y, m, d] = iso.split("-").map(Number) as [number, number, number?];
  return new Date(Date.UTC(y, m - 1, d ?? 1));
}

/** Intl date formatter pinned to UTC (inputs are calendar dates, not instants). */
export function dateFormat(locale: Locale, opts: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
  return new Intl.DateTimeFormat(locale, { timeZone: "UTC", ...opts });
}

/** '2026-09' → 'September 2026' (en) / '2026年9月' (zh-CN). */
export function monthLabel(month: string, locale: Locale): string {
  return dateFormat(locale, { year: "numeric", month: "long" }).format(utcDate(month));
}

/** 'YYYY-MM-DD' in local time. */
export function todayLocal(now = clockNow()): string {
  return `${currentMonth(now)}-${String(now.getDate()).padStart(2, "0")}`;
}

/**
 * '2026-09-28' → 'Sep 28' / '9月28日'; with `weekday`, 'Mon, Sep 28' / '9月28日 周一'. With `relative`,
 * today and yesterday read 'Today' / 'Yesterday' ('今天' / '昨天'). `year` adds the year.
 */
export function dayLabel(
  date: string,
  locale: Locale,
  opts: { relative?: boolean; weekday?: boolean; year?: boolean; today?: string } = {},
): string {
  const iso = date.slice(0, 10);
  if (opts.relative) {
    const today = opts.today ?? todayLocal();
    const [ty, tm, td] = today.split("-").map(Number) as [number, number, number];
    const offset = iso === today ? 0 : iso === todayLocal(new Date(ty, tm - 1, td - 1)) ? -1 : null;
    if (offset !== null) {
      const word = new Intl.RelativeTimeFormat(locale, { numeric: "auto" }).format(offset, "day");
      return word.charAt(0).toUpperCase() + word.slice(1);
    }
  }
  const d = utcDate(iso);
  if (locale === "zh-CN") {
    const base = `${opts.year ? `${d.getUTCFullYear()}年` : ""}${dateFormat(locale, { month: "long", day: "numeric" }).format(d)}`;
    return opts.weekday ? `${base} ${dateFormat(locale, { weekday: "short" }).format(d)}` : base;
  }
  return dateFormat(locale, {
    month: "short",
    day: "numeric",
    ...(opts.weekday ? { weekday: "short" } : {}),
    ...(opts.year ? { year: "numeric" } : {}),
  }).format(d);
}
