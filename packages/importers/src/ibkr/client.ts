// IBKR Flex Web Service v3 client (built-in fetch, no SDK). See README.md for the verified facts.
import { CodedError, type MessageParams } from "../errors";
import { child, parseXml, type XmlElement } from "../util/xml";

export const FLEX_SEND_REQUEST_URL = "https://ndcdyn.interactivebrokers.com/AccountManagement/FlexWebService/SendRequest";
export const FLEX_GET_STATEMENT_URL = "https://ndcdyn.interactivebrokers.com/AccountManagement/FlexWebService/GetStatement";
/** IBKR: "Programmatic access requires the User-Agent HTTP header to be set. Accepted values are: Blackberry or Java." */
export const FLEX_USER_AGENT = "Java";

export type FlexErrorKind =
  | "token_expired"
  | "token_invalid"
  | "ip_restricted"
  | "query_invalid"
  | "rate_limited"
  | "in_progress_timeout"
  | "unavailable"
  | "range_invalid"
  | "other";

/** Stable code per kind (the UI translates it); `flexCode` travels in params. */
export const FLEX_ERROR_CODES: Record<FlexErrorKind, string> = {
  token_expired: "invest_ibkr_token_expired",
  token_invalid: "invest_ibkr_token_invalid",
  ip_restricted: "invest_ibkr_ip_restricted",
  query_invalid: "invest_ibkr_query_invalid",
  rate_limited: "invest_ibkr_rate_limited",
  in_progress_timeout: "invest_flex_in_progress_timeout",
  unavailable: "invest_ibkr_unavailable",
  range_invalid: "invest_ibkr_range_invalid",
  other: "invest_ibkr_error",
};

/** A Flex failure. `flexCode` is IBKR's ErrorCode (e.g. "1012") when the service sent one. */
export class FlexError extends CodedError {
  constructor(
    readonly kind: FlexErrorKind,
    readonly flexCode: string | null,
    message: string,
    params: MessageParams = {},
  ) {
    super(FLEX_ERROR_CODES[kind], message, { ...(flexCode ? { flexCode } : {}), ...params });
    this.name = "FlexError";
  }
}

/** Codes that mean "not ready yet / busy, ask again shortly" (IBKR error code table). */
export const FLEX_RETRY_CODES = new Set(["1001", "1004", "1005", "1006", "1007", "1008", "1009", "1019", "1021"]);
/** "Too many requests have been made from this token." Limit: 1 request/second, 10/minute per token. */
export const FLEX_RATE_LIMIT_CODE = "1018";

const FATAL: Record<string, FlexErrorKind> = {
  "1012": "token_expired",
  "1015": "token_invalid",
  "1013": "ip_restricted",
  "1014": "query_invalid",
  "1003": "other",
  "1010": "query_invalid",
  "1011": "token_invalid",
  "1016": "other",
  "1017": "other",
  "1020": "other",
};

export interface FlexClientOptions {
  token: string;
  queryId: string;
  fetch?: typeof fetch;
  /** Injected in tests; defaults to setTimeout. */
  sleep?: (ms: number) => Promise<void>;
  /** Per HTTP request. Default 60 s. */
  timeoutMs?: number;
  /** Longest total wait for a statement still being generated. Default 5 minutes. */
  maxWaitMs?: number;
  /** First wait between polls; doubled per retry up to `maxDelayMs`. Defaults 5 s and 30 s. */
  initialDelayMs?: number;
  maxDelayMs?: number;
}

/** IBKR: a SendRequest override may cover "up to 365 days" (`p` 1-365, or `fd`/`td`). */
export const FLEX_MAX_RANGE_DAYS = 365;

/**
 * SendRequest period override, replacing the period saved in the query. `days`: `p`, "number of days from
 * the current date". `from`/`to`: `fd`/`td` (YYYY-MM-DD here, sent as yyyymmdd), both required together; yomi
 * treats both as inclusive, so the span from..to counts at most 365 calendar days.
 */
export type FlexRange = { days: number } | { from: string; to: string };

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

function validIsoDate(v: string): boolean {
  const m = ISO_DATE.exec(v);
  if (!m) return false;
  const d = new Date(`${v}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v;
}

/** Calendar days from `from` to `to`, both counted (2026-10-01..2026-10-01 is 1). */
export function inclusiveDays(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000) + 1;
}

const rangeError = (message: string, params: MessageParams = {}) =>
  new FlexError("range_invalid", null, message, { max: FLEX_MAX_RANGE_DAYS, ...params });

/** The SendRequest query parameters of a range (`p`, or `fd` + `td`); throws `range_invalid` before anything is sent. */
export function flexRangeParams(range: FlexRange): Record<string, string> {
  if ("days" in range) {
    if (!Number.isInteger(range.days) || range.days < 1 || range.days > FLEX_MAX_RANGE_DAYS) {
      throw rangeError(`Flex period must be 1 to ${FLEX_MAX_RANGE_DAYS} days, got ${String(range.days)}`, { days: String(range.days) });
    }
    return { p: String(range.days) };
  }
  if (!validIsoDate(range.from) || !validIsoDate(range.to)) throw rangeError(`Flex range dates must be YYYY-MM-DD, got ${range.from}..${range.to}`);
  const span = inclusiveDays(range.from, range.to);
  if (span < 1) throw rangeError(`Flex range starts after it ends: ${range.from}..${range.to}`);
  if (span > FLEX_MAX_RANGE_DAYS) throw rangeError(`Flex range covers ${span} days, more than ${FLEX_MAX_RANGE_DAYS}`, { days: span });
  return { fd: range.from.replaceAll("-", ""), td: range.to.replaceAll("-", "") };
}

export interface FlexClient {
  /**
   * SendRequest, then GetStatement until the statement is ready. Returns the FlexQueryResponse XML. Without
   * `range` the period saved in the query applies.
   */
  fetchStatement(range?: FlexRange): Promise<string>;
}

type Step = { kind: "done"; xml: string } | { kind: "ref"; code: string; url: string | null } | { kind: "retry"; code: string; message: string };

function textOf(el: XmlElement, name: string): string | null {
  return child(el, name, true)?.text || null;
}

/** Classifies one Flex HTTP answer: the statement itself, a reference code, a retryable status, or a thrown FlexError. */
export function readFlexAnswer(body: string): Step {
  let root: XmlElement;
  try {
    root = parseXml(body);
  } catch {
    throw new FlexError("unavailable", null, "Flex answer is not XML");
  }
  if (root.name === "FlexQueryResponse") return { kind: "done", xml: body };
  if (root.name !== "FlexStatementResponse") throw new FlexError("unavailable", null, `unexpected Flex answer <${root.name}>`);
  const status = (textOf(root, "Status") ?? "").toLowerCase();
  const ref = textOf(root, "ReferenceCode");
  if (status === "success" && ref) return { kind: "ref", code: ref, url: textOf(root, "Url") };
  const code = textOf(root, "ErrorCode") ?? "";
  const message = textOf(root, "ErrorMessage") ?? `Flex status ${status || "unknown"}`;
  if (FLEX_RETRY_CODES.has(code) || code === FLEX_RATE_LIMIT_CODE) return { kind: "retry", code, message };
  throw new FlexError(FATAL[code] ?? "other", code || null, `IBKR Flex error ${code || "?"}: ${message}`);
}

/** Only IBKR hosts are followed (the GetStatement URL comes back inside the SendRequest answer). */
function statementUrl(url: string | null): string {
  if (!url) return FLEX_GET_STATEMENT_URL;
  try {
    const u = new URL(url);
    if (u.protocol === "https:" && (u.hostname === "interactivebrokers.com" || u.hostname.endsWith(".interactivebrokers.com"))) {
      return `${u.origin}${u.pathname}`;
    }
  } catch {
    // fall through
  }
  return FLEX_GET_STATEMENT_URL;
}

export function createFlexClient(opts: FlexClientOptions): FlexClient {
  const doFetch = opts.fetch ?? fetch;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const maxWait = opts.maxWaitMs ?? 5 * 60 * 1000;
  const firstDelay = opts.initialDelayMs ?? 5000;
  const maxDelay = opts.maxDelayMs ?? 30_000;

  async function get(base: string, q: string, extra: Record<string, string> = {}): Promise<string> {
    const u = new URL(base);
    u.searchParams.set("t", opts.token);
    u.searchParams.set("q", q);
    u.searchParams.set("v", "3");
    for (const [k, v] of Object.entries(extra)) u.searchParams.set(k, v);
    let res: Response;
    try {
      res = await doFetch(u.toString(), {
        method: "GET",
        headers: { "User-Agent": FLEX_USER_AGENT },
        signal: AbortSignal.timeout(opts.timeoutMs ?? 60_000),
      });
    } catch (e) {
      throw new FlexError("unavailable", null, `IBKR Flex request failed: ${e instanceof Error ? e.message : String(e)}`);
    }
    const text = await res.text();
    if (!res.ok) throw new FlexError("unavailable", null, `IBKR Flex HTTP ${res.status}`);
    return text;
  }

  /** Repeats `call` while it answers with a retryable code, sleeping with doubling delays; bounded by maxWait. */
  async function withRetry(call: () => Promise<Step>): Promise<Exclude<Step, { kind: "retry" }>> {
    let waited = 0;
    let delay = firstDelay;
    for (;;) {
      const step = await call();
      if (step.kind !== "retry") return step;
      const wait = step.code === FLEX_RATE_LIMIT_CODE ? Math.max(delay, 10_000) : delay;
      if (waited + wait > maxWait) {
        if (step.code === FLEX_RATE_LIMIT_CODE) throw new FlexError("rate_limited", step.code, `IBKR Flex rate limit: ${step.message}`);
        throw new FlexError("in_progress_timeout", step.code, `IBKR Flex statement not ready after ${Math.round(waited / 1000)} s (${step.code}: ${step.message})`);
      }
      await sleep(wait);
      waited += wait;
      delay = Math.min(delay * 2, maxDelay);
    }
  }

  return {
    async fetchStatement(range) {
      const extra = range ? flexRangeParams(range) : {};
      const sent = await withRetry(async () => readFlexAnswer(await get(FLEX_SEND_REQUEST_URL, opts.queryId, extra)));
      if (sent.kind === "done") return sent.xml;
      const url = statementUrl(sent.url);
      // The statement is generated asynchronously: give it a moment before the first poll.
      await sleep(Math.min(firstDelay, 5000));
      const got = await withRetry(async () => readFlexAnswer(await get(url, sent.code)));
      if (got.kind !== "done") throw new FlexError("unavailable", null, "GetStatement answered with a new reference code");
      return got.xml;
    },
  };
}
