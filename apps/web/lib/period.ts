/** Period labels for /stats and ranged /transactions. Pure, usable on server and client. */

import type { Locale } from "../i18n/config";
import type { Dictionary } from "../i18n/en";
import { plural } from "../i18n/format";
import { dateFormat, utcDate } from "./month";

const DATE_RE = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;

export function isDateString(v: unknown): v is string {
  if (typeof v !== "string" || !DATE_RE.test(v)) return false;
  const [y, m, d] = v.split("-").map(Number) as [number, number, number];
  return d <= new Date(Date.UTC(y, m, 0)).getUTCDate();
}

function lastDay(month: string): string {
  const [y, m] = month.split("-").map(Number) as [number, number];
  return `${month}-${String(new Date(Date.UTC(y, m, 0)).getUTCDate()).padStart(2, "0")}`;
}

/** Whole calendar months the range covers exactly, else null. */
export function wholeMonthCount(from: string, to: string): number | null {
  if (from.slice(8) !== "01" || to !== lastDay(to.slice(0, 7))) return null;
  const [fy, fm] = from.split("-").map(Number) as [number, number];
  const [ty, tm] = to.split("-").map(Number) as [number, number];
  return (ty - fy) * 12 + (tm - fm) + 1;
}

const md = (d: string) => `${Number(d.slice(5, 7))}月${Number(d.slice(8, 10))}日`;
const ymd = (d: string) => `${Number(d.slice(0, 4))}年${md(d)}`;

/** Intl range output with plain spaces instead of thin ones around the dash. */
const plainSpaces = (s: string) => s.replace(/[\u2009\u202f]/g, " ");

/**
 * zh-CN: '2026年9月', '2026年', '2026年7月 至 9月', '2026年9月5日 至 9月20日', '2025年11月15日 至 2026年2月3日'.
 * en: 'September 2026', '2026', 'Jul – Sep 2026', 'Sep 5 – 20, 2026', 'Nov 15, 2025 – Feb 3, 2026'.
 */
export function rangeLabel(from: string, to: string, locale: Locale): string {
  const months = wholeMonthCount(from, to);
  const sameYear = from.slice(0, 4) === to.slice(0, 4);
  const y = Number(from.slice(0, 4));
  if (months === 12 && from.slice(5, 7) === "01") return locale === "zh-CN" ? `${y}年` : String(y);
  if (locale !== "zh-CN") {
    if (months === 1) return dateFormat(locale, { year: "numeric", month: "long" }).format(utcDate(from));
    const opts: Intl.DateTimeFormatOptions = months != null ? { year: "numeric", month: "short" } : { year: "numeric", month: "short", day: "numeric" };
    return plainSpaces(dateFormat(locale, opts).formatRange(utcDate(from), utcDate(to)));
  }
  if (months === 1) return `${y}年${Number(from.slice(5, 7))}月`;
  if (months != null) {
    const end = sameYear ? `${Number(to.slice(5, 7))}月` : `${Number(to.slice(0, 4))}年${Number(to.slice(5, 7))}月`;
    return `${y}年${Number(from.slice(5, 7))}月 至 ${end}`;
  }
  if (from === to) return ymd(from);
  return `${ymd(from)} 至 ${sameYear ? md(to) : ymd(to)}`;
}

/**
 * How the previous period reads in a comparison: "last week" (seven days from a Monday), "last month", "last year",
 * "the previous 3 months", "the previous 10 days".
 */
export function previousLabel(from: string, to: string, lengthDays: number, t: Dictionary): string {
  if (lengthDays === 7 && utcDate(from).getUTCDay() === 1) return t.stats.previous.week;
  const months = wholeMonthCount(from, to);
  if (months === 1) return t.stats.previous.month;
  if (months === 12 && from.slice(5, 7) === "01") return t.stats.previous.year;
  if (months != null) return plural(t.stats.previous.months, months);
  return plural(t.stats.previous.days, lengthDays);
}

/** 'YYYY-MM' → 'Sep' / '9月', with the year when asked: 'Jan 2026' / '2026年1月'. */
export function shortMonth(month: string, locale: Locale, withYear = false): string {
  return dateFormat(locale, withYear ? { year: "numeric", month: "short" } : { month: "short" }).format(utcDate(month));
}
