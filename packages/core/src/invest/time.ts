// US market calendar helpers in America/New_York, built on Intl (no date library).
import { addDays, weekdayOf } from "../time/day";

export const MARKET_TZ = "America/New_York";
/** Flex statements for a trading day are pulled after this local hour (market closes 16:00, data settles later). */
export const AFTER_CLOSE_HOUR = 18;

const fmt = new Intl.DateTimeFormat("en-CA", {
  timeZone: MARKET_TZ,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  hourCycle: "h23",
  weekday: "short",
});

/** Local calendar date (YYYY-MM-DD), hour and weekday (0 = Sunday) of `now` in New York. */
export function marketClock(now: Date): { date: string; hour: number; weekday: number } {
  const parts = Object.fromEntries(fmt.formatToParts(now).map((p) => [p.type, p.value]));
  const weekday = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(parts.weekday ?? "");
  return { date: `${parts.year}-${parts.month}-${parts.day}`, hour: Number(parts.hour), weekday };
}

/** The weekday before `date` (Friday for a Monday or a weekend day). */
export function previousWeekday(date: string): string {
  let d = addDays(date, -1);
  while (weekdayOf(d) === 0 || weekdayOf(d) === 6) d = addDays(d, -1);
  return d;
}

/**
 * The latest weekday whose after-close statement should exist at `now`: today once it is past 18:00
 * in New York on a weekday, else the weekday before. Exchange holidays are not modelled; on a holiday
 * IBKR returns the previous trading day and the job records that it already asked for this target.
 */
export function lastCompletedTradingDay(now: Date): string {
  const c = marketClock(now);
  const isWeekday = c.weekday >= 1 && c.weekday <= 5;
  if (isWeekday && c.hour >= AFTER_CLOSE_HOUR) return c.date;
  return previousWeekday(c.date);
}

/** Retries for a late statement stop at this New York hour on the morning after the expected day. */
export const RETRY_UNTIL_HOUR = 6;

/** True once `now` is at or past 06:00 New York on the calendar day after `day`. */
export function retryWindowClosed(day: string, now: Date): boolean {
  const c = marketClock(now);
  const next = addDays(day, 1);
  return c.date > next || (c.date === next && c.hour >= RETRY_UNTIL_HOUR);
}
