import { addDays, isDate } from "../time/day";

/**
 * The days a statement file covers, both inclusive, from the period it states (`ParseResult.periodStart/periodEnd`:
 * a date, or a local time with an offset such as Alipay's `2026-09-29T15:02:11+08:00`). The days are the file's own
 * calendar days. An end before 23:59 means the export was taken while that day was still running, so the file
 * covers through the day before. Pure.
 */
export function statementCoverage(periodStart?: string | null, periodEnd?: string | null): { start: string | null; end: string | null } {
  const day = (v?: string | null) => (v && isDate(v.slice(0, 10)) ? v.slice(0, 10) : null);
  const start = day(periodStart);
  let end = day(periodEnd);
  const time = end ? /T(\d{2}):(\d{2})/.exec(periodEnd!) : null;
  if (end && time && (Number(time[1]) < 23 || Number(time[2]) < 59)) end = addDays(end, -1);
  if (start && end && end < start) end = null;
  return { start, end };
}
