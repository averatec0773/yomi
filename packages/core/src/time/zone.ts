// Time zone helpers on ISO strings. Pure (Intl only), safe to import from the web client.

import { clockNow } from "./clock";

export { clockNow } from "./clock";

export const DEFAULT_TIME_ZONE = "America/Chicago";

/**
 * Sources whose occurred_at carries a calendar date only (the time is a fixed noon marker): BoA CSV and
 * Plaid post dates, manual entries picked on a date. Their day is the stated date in any zone.
 */
const DATE_ONLY_SOURCES: ReadonlySet<string> = new Set(["boa_csv", "plaid", "manual"]);

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatter(timeZone: string): Intl.DateTimeFormat {
  let f = formatters.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    formatters.set(timeZone, f);
  }
  return f;
}

/** True for a zone name Intl accepts (IANA names such as 'America/Chicago', or 'UTC'). */
export function isTimeZone(value: unknown): value is string {
  if (typeof value !== "string" || value.length === 0 || value.length > 64) return false;
  try {
    formatter(value);
    return true;
  } catch {
    return false;
  }
}

/** An ISO timestamp with a time and an explicit offset or Z, so it names one instant. */
function hasInstant(iso: string): boolean {
  return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})$/.test(iso);
}

/** Wall-clock parts of an instant in `timeZone`: 'YYYY-MM-DD' and 'HH:MM:SS'. Null when `iso` is not an instant. */
export function zonedParts(iso: string, timeZone: string): { date: string; time: string } | null {
  if (!hasInstant(iso)) return null;
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return null;
  const p: Record<string, string> = {};
  for (const part of formatter(timeZone).formatToParts(ms)) p[part.type] = part.value;
  return { date: `${p.year}-${p.month}-${p.day}`, time: `${p.hour}:${p.minute}:${p.second}` };
}

/** The calendar day of `iso` in `timeZone`; a value without an instant keeps its own date. */
export function localDate(iso: string, timeZone: string): string {
  return zonedParts(iso, timeZone)?.date ?? iso.slice(0, 10);
}

/** occurred_on for a transaction: its day in the user's zone, or the stated date for date-only sources. */
export function occurredOnFor(occurredAt: string, source: string, timeZone: string): string {
  return DATE_ONLY_SOURCES.has(source) ? occurredAt.slice(0, 10) : localDate(occurredAt, timeZone);
}

/** 'HH:MM:SS' of a transaction in the user's zone; date-only sources keep their stated time. */
export function occurredTimeFor(occurredAt: string, source: string, timeZone: string): string {
  if (DATE_ONLY_SOURCES.has(source)) return occurredAt.slice(11, 19);
  return zonedParts(occurredAt, timeZone)?.time ?? occurredAt.slice(11, 19);
}

/** Today's 'YYYY-MM-DD' in `timeZone`. */
export function todayIn(timeZone: string, now: Date = clockNow()): string {
  return localDate(now.toISOString(), timeZone);
}

/** Every IANA zone this runtime knows, sorted; falls back to a short list on runtimes without supportedValuesOf. */
export function timeZoneNames(): string[] {
  const intl = Intl as unknown as { supportedValuesOf?: (key: string) => string[] };
  const list = intl.supportedValuesOf?.("timeZone") ?? [];
  const base = list.length > 0 ? list : [DEFAULT_TIME_ZONE, "America/New_York", "America/Los_Angeles", "Asia/Shanghai", "UTC"];
  return [...new Set([...base, "UTC"])].sort();
}
