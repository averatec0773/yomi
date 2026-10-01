// ICBC (工商银行) 95588 credit card alerts pasted as text. Pure: text in, one typed record out.
//
// Supported phrasing (Chinese is the bank's fixed wording, matched verbatim):
//   您尾号3141信用卡9月27日08:24POS支出(消费BUSY BEE BOBA Houston)15.74美元。【工商银行】
//   您尾号3141信用卡9月27日08:38网上银行支出(消费)14.48美元。【工商银行】
//   您尾号3141信用卡9月28日10:02退货收入(退货BUSY BEE BOBA Houston)15.74美元。【工商银行】  (credits: 收入 / 存入 / 退货 / 退款, inferred)
// The channel before the direction word (POS, 网上银行, 快捷支付, ...) is free text. Text after the amount
// (available credit, the signature) is ignored. Currencies: 美元 USD, 港币/港元 HKD, 人民币/元 CNY.
//
// Time zone: ICBC sends these alerts with Beijing time (the SMS carries no zone), and the ICBC PDF
// importer (icbc/parse.ts) books 入账日期 as +08:00 too, so both land on the same clock. The SMS has no
// year: it is the year of `today`, or the year before when that date would be more than a day ahead.

import { parseAmountMinor } from "../util/amount";

export interface IcbcSms {
  bank: "icbc";
  last4: string;
  /** ISO local time in Beijing time, e.g. 2026-09-27T08:24:00+08:00. */
  occurredAt: string;
  /** POS, 网上银行, ... ("" when absent). */
  channel: string;
  /** 支出 / 收入 / 存入 / 退货 / 退款 as written. */
  directionWord: string;
  /** The leading summary inside the parentheses (消费, 退货, 还款, ...), "" when there is none. */
  summary: string;
  /** Merchant as written, without the trailing city ("" when the alert names none). */
  merchant: string;
  /** Trailing Title-case city split off the merchant (Houston), or null. */
  city: string | null;
  /** Signed minor units; negative = money leaving me. */
  amountMinor: number;
  currency: string;
  direction: "out" | "in";
  kind: "expense" | "income" | "transfer" | "refund";
  /** The pasted SMS, trimmed, verbatim. */
  text: string;
}

const CURRENCY: Record<string, string> = { 美元: "USD", 港币: "HKD", 港元: "HKD", 人民币: "CNY", 元: "CNY" };

const SMS_RE =
  /您尾号(\d{4})的?信用卡(\d{1,2})月(\d{1,2})日(\d{1,2}):(\d{2})\s*([^()\d]*?)(支出|收入|存入|退货|退款)\(([^()]*)\)\s*([\d,]+(?:\.\d{1,2})?)\s*(美元|港币|港元|人民币|元)/;
const SUMMARY_RE = /^(消费|退货|退款|还款|存入|转入|取现|预借现金|年费|利息|返现|分期)/;
const REBATE_RE = /REBATE|CASH\s?BACK|返现/i;

const pad = (n: number | string) => String(n).padStart(2, "0");

/** Full-width parentheses, colon, digits and spaces to ASCII so the pattern sees one spelling. */
function normalize(text: string): string {
  return text
    .replace(/[\uFF01-\uFF5E]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xfee0))
    .replace(/\u3000/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** True for text that is an ICBC alert, readable or not (so the UI can say it is not supported yet). */
export function looksLikeIcbcSms(text: string): boolean {
  const s = normalize(text);
  return /【工商银行】|\[工商银行\]/.test(s) || /^您尾号\d{4}/.test(s);
}

/** `BUSY BEE BOBA Houston` → merchant `BUSY BEE BOBA`, city `Houston`: Title-case words after an all-caps name. */
export function splitMerchantCity(place: string): { merchant: string; city: string | null } {
  const tokens = place.split(" ").filter(Boolean);
  let cut = tokens.length;
  while (cut > 1 && /^[A-Z][a-z]+\.?$/.test(tokens[cut - 1]!)) cut--;
  const head = tokens.slice(0, cut);
  if (cut === tokens.length || head.some((t) => /[a-z]/.test(t)) || !head.some((t) => /[A-Z]/.test(t))) {
    return { merchant: tokens.join(" "), city: null };
  }
  return { merchant: head.join(" "), city: tokens.slice(cut).join(" ") };
}

function yearFor(month: number, day: number, today: string): number {
  const [ty = 1970, tm = 1, td = 1] = today.split("-").map(Number);
  const ahead = Date.UTC(ty, month - 1, day) - Date.UTC(ty, tm - 1, td);
  return ahead > 86_400_000 ? ty - 1 : ty;
}

function validDay(y: number, m: number, d: number): boolean {
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

/**
 * Reads one ICBC credit card alert. Returns null when the text is not a supported alert.
 * `today` is 'YYYY-MM-DD' and only picks the year.
 */
export function parseIcbcSms(text: string, opts: { today: string }): IcbcSms | null {
  const s = normalize(text);
  const m = SMS_RE.exec(s);
  if (!m) return null;
  const [, last4, mo, d, h, mi, channel = "", dirWord, inside = "", amountText, currencyWord] = m as unknown as string[];
  const month = Number(mo);
  const day = Number(d);
  const hour = Number(h);
  const year = yearFor(month, day, opts.today);
  if (!validDay(year, month, day) || hour > 23 || Number(mi) > 59) return null;
  const currency = CURRENCY[currencyWord!];
  if (!currency) return null;
  let abs: number;
  try {
    abs = parseAmountMinor(amountText!);
  } catch {
    return null;
  }
  if (abs <= 0) return null;

  const content = inside.trim();
  const summary = SUMMARY_RE.exec(content)?.[1] ?? "";
  const { merchant, city } = splitMerchantCity(content.slice(summary.length).trim());
  const out = dirWord === "支出";
  const refund = dirWord === "退货" || dirWord === "退款" || summary === "退货" || summary === "退款";
  const kind: IcbcSms["kind"] = out ? "expense" : REBATE_RE.test(content) ? "income" : refund ? "refund" : "transfer";

  return {
    bank: "icbc",
    last4: last4!,
    occurredAt: `${year}-${pad(month)}-${pad(day)}T${pad(hour)}:${mi}:00+08:00`,
    channel: channel.trim(),
    directionWord: dirWord!,
    summary,
    merchant,
    city,
    amountMinor: out ? -abs : abs,
    currency,
    direction: out ? "out" : "in",
    kind,
    text: text.trim(),
  };
}
