import { ParseError } from "../errors";

const CN_OFFSET = "+08:00";

const pad = (n: number | string) => String(n).padStart(2, "0");

/** `2026-09-01 12:30:00` (also `2026/9/1 12:30`) in China time to `2026-09-01T12:30:00+08:00`. */
export function localTextToIso(text: string): string {
  const m = /^(\d{4})[-/](\d{1,2})[-/](\d{1,2})[ T]+(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(text.trim());
  if (!m) throw new ParseError("import_bad_time", `Cannot parse time: ${JSON.stringify(text)}`, { value: text });
  const [, y, mo, d, h, mi, s = "00"] = m;
  return `${y}-${pad(mo!)}-${pad(d!)}T${pad(h!)}:${mi}:${pad(s)}${CN_OFFSET}`;
}

/**
 * exceljs turns a date serial into a Date as if the wall clock were UTC, so the UTC
 * getters return the wall-clock time printed in the sheet. The file states its times are
 * UTC+08:00, hence the fixed offset. Rounded to the second to absorb serial float noise.
 */
export function excelDateToIso(date: Date): string {
  const d = new Date(Math.round(date.getTime() / 1000) * 1000);
  return (
    `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}` +
    `T${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}${CN_OFFSET}`
  );
}

/** `2026-09-01T12:30:00+08:00` back to the sheet's display text `2026-09-01 12:30:00`. */
export function isoToLocalText(iso: string): string {
  return iso.slice(0, 19).replace("T", " ");
}
