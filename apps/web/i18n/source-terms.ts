import type { Dictionary } from "./en";
import { fmt } from "./format";

/** Stored statement terms use full-width parentheses (微信红包（单发）); accept ASCII ones too. */
function key(term: string): string {
  return term.trim().replace(/\(/g, "（").replace(/\)/g, "）");
}

/**
 * Display text for a fixed statement term (ICBC 摘要, WeChat 交易类型, Alipay 交易分类). English shows the
 * English term, null for terms that carry no information (消费), and anything unknown as stored (merchant
 * names are proper nouns). zh-CN shows the stored text. Stored rows are never changed.
 */
export function sourceTermLabel(term: string, t: Dictionary): string | null {
  const s = term.trim();
  if (!s) return null;
  const st = t.sourceTerms;
  if (!st.translate) return s;
  if (st.hidden.includes(s)) return null;
  const exact = st.terms[key(s)];
  if (exact) return exact;
  const refund = /^(.+?)\s*[-－]\s*退款$/.exec(s);
  if (refund) {
    const base = st.terms[key(refund[1]!)];
    if (base) return fmt(st.refundOf, { term: base });
  }
  return s;
}

const WORD_SPLIT = /[^A-Z0-9]+/;
/** Bank boilerplate words, not part of what was bought. */
const NOISE = new Set(["PURCHASE", "PURCHASES", "CHECKCARD", "CHECK", "CARD", "DEBIT", "POS", "RECURRING", "AUTHORIZED", "ON", "TST", "SQ", "SP", "PAYPAL"]);

function words(s: string): string[] {
  return s.toUpperCase().split(WORD_SPLIT).filter(Boolean);
}

/**
 * Whether a raw US bank description (BoA CSV, Plaid) says nothing beyond the merchant: after dropping dates
 * (MM/DD), boilerplate (PURCHASE, CHECKCARD), card, store and reference numbers, every word is part of the
 * merchant or comes after it (city, state). `CHECKCARD 0915 STARBUCKS STORE 1234 SEATTLE WA 2400…` adds
 * nothing to `Starbucks Store`; `Zelle payment to ANNA Conf# 123` adds something to `ANNA`.
 */
export function bankDescriptionAddsNothing(description: string, merchant: string): boolean {
  const m = new Set(words(merchant));
  if (m.size === 0) return false;
  const rest = words(description.replace(/\b\d{1,2}\/\d{1,2}(?:\/\d{2,4})?\b/g, " ")).filter((w) => !/\d/.test(w) && !NOISE.has(w));
  const last = rest.reduce((at, w, i) => (m.has(w) ? i : at), -1);
  if (last < 0) return false;
  return rest.slice(0, last + 1).every((w) => m.has(w));
}

/**
 * The secondary text a row shows next to its merchant: the description unless it repeats the merchant, adds
 * nothing to it (US bank boilerplate), or is a fixed term that is hidden in this language; fixed terms show
 * in the UI language.
 */
export function displayDescription(tx: { description: string; merchant: string; source: string }, t: Dictionary): string | null {
  const d = tx.description.trim();
  if (!d || d === tx.merchant) return null;
  if ((tx.source === "boa_csv" || tx.source === "plaid") && bankDescriptionAddsNothing(d, tx.merchant)) return null;
  return sourceTermLabel(d, t);
}
