// Deterministic merchant cleanup. Chinese counterparties pass through unchanged (apart from whitespace).

const US_STATES = new Set(
  (
    "AL AK AZ AR CA CO CT DE FL GA HI ID IL IN IA KS KY LA ME MD MA MI MN MS MO MT NE NV NH NJ NM NY NC ND OH OK OR " +
    "PA RI SC SD TN TX UT VT VA WA WV WI WY DC PR"
  ).split(" "),
);

const PREFIX_RE = /^(?:TST\s*\*|SQ\s*\*|SP\s+|UEP\s*\*|PAYPAL\s*\*|DD\s*\*|PY\s*\*)\s*/i;
const CJK_RE = /[㐀-鿿豈-﫿]/;
const STORE_NO_RE = /^(?:#\s*\d+|NO\.?\s*\d+|\d{3,})$/i;
/** Trailing reference tokens: `CC1610834036`, or any token carrying six or more digits. */
const REF_TOKEN_RE = /^(?:CC\d+|[A-Z#-]*\d{6,}[A-Z\d-]*)$/i;

/** Corporate suffixes (`Inc`, `LLC`, `Pte. Ltd.`, ...) and marketplace tags; what follows them is location noise. */
const CORP_RE = /^(?:inc|llc|ltd|pte|co|corp|mktpl|mktp|mktplace)[.,]?$/i;
/** At most a 2-3 word city plus a state code may follow a corporate token. */
const MAX_AFTER_CORP = 3;

function collapse(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

function titleCase(s: string): string {
  return s.toLowerCase().replace(/(^|[\s\-/&])([a-z])/g, (_, sep: string, c: string) => sep + c.toUpperCase());
}

export function cleanMerchant(counterparty: string | null | undefined): string {
  const original = collapse(counterparty ?? "");
  if (!original || CJK_RE.test(original)) return original;

  let s = original;
  for (let prev = ""; prev !== s; ) {
    prev = s;
    s = s.replace(PREFIX_RE, "");
  }

  // `LinkedIn*P3037300946` → `LinkedIn`: the part after `*` is a reference.
  const star = s.indexOf("*");
  if (star > 0) s = s.slice(0, star);

  let tokens = collapse(s).split(" ").filter(Boolean);
  // Trailing state code, then everything from the first store number on (the city follows it).
  if (tokens.length > 1 && US_STATES.has(tokens[tokens.length - 1]!.toUpperCase())) tokens = tokens.slice(0, -1);
  const storeIdx = tokens.findIndex((t, i) => i > 0 && STORE_NO_RE.test(t));
  if (storeIdx > 0) tokens = tokens.slice(0, storeIdx);
  // `Weee! Inc Fremont` → `Weee!`, `Amazon Mktpl` → `Amazon`.
  const corpIdx = tokens.findIndex((t, i) => i > 0 && CORP_RE.test(t));
  if (corpIdx > 0 && tokens.length - corpIdx - 1 <= MAX_AFTER_CORP) tokens = tokens.slice(0, corpIdx);
  while (tokens.length > 1 && (/^[\d#\-.,]+$/.test(tokens.at(-1)!) || REF_TOKEN_RE.test(tokens.at(-1)!))) {
    tokens = tokens.slice(0, -1);
  }

  s = collapse(tokens.join(" ")).replace(/[\s#*\-.,]+$/, "");
  if (!s) return original;
  return /[a-z]/.test(s) ? s : titleCase(s);
}
