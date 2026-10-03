// Calendar arithmetic on 'YYYY-MM-DD' and 'YYYY-MM' strings: no time zone, no clock. Pure.
// "Today" in the user's zone is todayIn (./zone); everything here works on dates already decided.

const DAY_MS = 86_400_000;
const DATE_RE = /^(\d{4})-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;
const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

/** A real calendar date 'YYYY-MM-DD' (no Feb 30). */
export function isDate(s: unknown): s is string {
  if (typeof s !== "string") return false;
  const m = DATE_RE.exec(s);
  return m != null && Number(m[3]) <= daysInMonth(`${m[1]}-${m[2]}`);
}

export function isMonth(s: string): boolean {
  return MONTH_RE.test(s);
}

/** Days since 1970-01-01 of a date; a full ISO timestamp counts by its stated date (the first 10 characters). */
export function dayNumber(date: string): number {
  const [y, m, d] = date.slice(0, 10).split("-").map(Number);
  return Date.UTC(y ?? 0, (m ?? 1) - 1, d ?? 1) / DAY_MS;
}

export function addDays(date: string, n: number): string {
  return new Date((dayNumber(date) + n) * DAY_MS).toISOString().slice(0, 10);
}

/** Signed days from `from` to `to` (0 on the same day, 1 for the next day). */
export function dayDiff(from: string, to: string): number {
  return dayNumber(to) - dayNumber(from);
}

/** Days from `from` to `to`, both counted (a single day is 1). */
export function daysInclusive(from: string, to: string): number {
  return dayDiff(from, to) + 1;
}

/** Day of the week of a calendar date: 0 = Sunday ... 6 = Saturday. */
export function weekdayOf(date: string): number {
  return new Date(dayNumber(date) * DAY_MS).getUTCDay();
}

export function daysInMonth(month: string): number {
  const [y, m] = month.split("-").map(Number);
  return new Date(Date.UTC(y ?? 0, m ?? 1, 0)).getUTCDate();
}

export function shiftMonth(month: string, delta: number): string {
  const [y, m] = month.split("-").map(Number);
  const idx = (y ?? 0) * 12 + (m ?? 1) - 1 + delta;
  return `${String(Math.floor(idx / 12)).padStart(4, "0")}-${String((idx % 12) + 1).padStart(2, "0")}`;
}

export function monthStart(month: string): string {
  return `${month}-01`;
}

export function monthEnd(month: string): string {
  return `${month}-${String(daysInMonth(month)).padStart(2, "0")}`;
}

/** "YYYY-MM" → [start, end) bounds comparable with occurred_on text. */
export function monthRange(month: string): { start: string; end: string } {
  return { start: monthStart(month), end: monthStart(shiftMonth(month, 1)) };
}
