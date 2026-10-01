import type { Dictionary } from "./en";
import { fmt } from "./format";

type Params = Record<string, string | number>;

/** Param values ready for a template: coded values (`reason`, `bucket`) translated, `*Minor` amounts as decimals. */
function localizeParams(params: Params, t: Dictionary): Params {
  const out: Params = {};
  for (const [k, v] of Object.entries(params)) {
    const coded = t.errors.params[k]?.[String(v)];
    if (coded !== undefined) out[k] = coded;
    else if (k.endsWith("Minor") && typeof v === "number") out[k] = (v / 100).toFixed(2);
    else out[k] = v;
  }
  return out;
}

/**
 * Text for an error or notice shown to the user: the dictionary entry for its `code` filled with its
 * `params` when there is one, else the server's (English) message.
 */
export function errorText(err: unknown, t: Dictionary): string {
  const e = err as { code?: unknown; message?: unknown; params?: unknown } | null;
  const code = typeof e?.code === "string" ? e.code : undefined;
  const byCode = code ? t.errors.codes[code] : undefined;
  if (byCode) {
    const params = e?.params && typeof e.params === "object" ? (e.params as Params) : {};
    return fmt(byCode, localizeParams(params, t));
  }
  if (typeof e?.message === "string" && e.message) return e.message;
  return t.errors.unknown;
}

/** Same as errorText for a warning `{ code, params, message }` (import receipts, bank sync results). */
export const noticeText = errorText;
