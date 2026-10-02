import { looksLikeIcbcSms, type MessageParams, parseIcbcSms } from "@yomi/importers";
import { keywordCategoryName } from "../import/categorize";
import { cleanMerchant } from "../import/merchant";
import { minorDigits, parseAmountToMinor } from "../money";
import type { SplitMode } from "../split/splits";
import { DEFAULT_TIME_ZONE, occurredOnFor } from "../time/zone";

export interface QuickParticipant {
  id: number;
  name: string;
  aliases?: readonly string[];
  isSelf?: boolean;
}

export interface QuickParseContext {
  /** 'YYYY-MM-DD' in the user's local time. */
  today: string;
  /** Ordered by preference (e.g. most recently used first); fuzzy matches pick the earliest. */
  participants: readonly QuickParticipant[];
  defaultCurrency: string;
  /** IANA zone for the day a pasted alert lands on (default America/Chicago). */
  timeZone?: string;
}

export type QuickErrorCode =
  | "quick_missing_amount"
  | "quick_amount_not_positive"
  | "quick_invalid_amount"
  | "quick_invalid_date"
  | "quick_unknown_participant"
  | "quick_treat"
  | "quick_sms_unsupported";

export interface QuickError {
  code: QuickErrorCode;
  /** English; the UI translates by `code` with `params`. */
  message: string;
  params: MessageParams;
  /** For quick_unknown_participant: the typed name, so the UI can offer to create it. */
  name?: string;
}

export interface QuickDraft {
  /** Positive minor units; null when no amount was found. */
  amountMinor: number | null;
  currency: string;
  description: string;
  date: string;
  /** Non-self participants sharing the cost (a friend payer sharing it is included). */
  participantIds: number[];
  /** null = I paid. */
  payerId: number | null;
  mode: SplitMode;
  categoryHint: string | null;
  errors: QuickError[];
  /** Set when the text is a pasted ICBC card alert; saving it goes through createSmsEntry. */
  sms?: QuickSms | null;
}

/** What the quick-add preview shows for a pasted card alert. */
export interface QuickSms {
  bank: "icbc";
  last4: string;
  /** ISO with +08:00 (Beijing time, as ICBC sends it). */
  occurredAt: string;
  /** Day of occurredAt in the user's time zone. */
  occurredOn: string;
  /** As written, without the city ("" when the alert names none). */
  merchant: string;
  /** Signed minor units; negative = spending. */
  amountMinor: number;
  currency: string;
  kind: "expense" | "income" | "transfer" | "refund";
  /** A card hold (预授权): saved as provisional and not counted until the statement row. */
  hold: boolean;
}

/** Everything from 您尾号 to the 【工商银行】 signature (or the end): what is left can still carry @people. */
const SMS_SPAN = /您尾号[\s\S]*?(?:【工商银行】|$)/;

function parseSmsEntry(text: string, ctx: QuickParseContext): QuickDraft | null {
  if (!looksLikeIcbcSms(text)) return null;
  const sms = parseIcbcSms(text, { today: ctx.today });
  if (!sms) {
    return {
      amountMinor: null,
      currency: ctx.defaultCurrency.toUpperCase(),
      description: "",
      date: ctx.today,
      participantIds: [],
      payerId: null,
      mode: "equal",
      categoryHint: null,
      errors: [{ code: "quick_sms_unsupported", message: "This bank message is not a supported ICBC card alert", params: {} }],
      sms: null,
    };
  }
  // "@roommate" typed after the alert splits it; the alert itself was paid with my card.
  const rest = text.replace(SMS_SPAN, " ").trim();
  const extra = rest ? parseQuickEntry(rest, ctx) : null;
  const merchant = cleanMerchant(sms.merchant);
  const occurredOn = occurredOnFor(sms.occurredAt, "sms", ctx.timeZone ?? DEFAULT_TIME_ZONE);
  return {
    amountMinor: Math.abs(sms.amountMinor),
    currency: sms.currency,
    description: merchant,
    date: occurredOn,
    participantIds: sms.kind === "expense" ? (extra?.participantIds ?? []) : [],
    payerId: null,
    mode: extra?.mode === "full" ? "full" : "equal",
    categoryHint: sms.kind === "expense" ? keywordCategoryName(merchant) : null,
    errors: (extra?.errors ?? []).filter((e) => e.code === "quick_unknown_participant"),
    sms: {
      bank: "icbc",
      last4: sms.last4,
      occurredAt: sms.occurredAt,
      occurredOn,
      merchant: sms.merchant,
      amountMinor: sms.amountMinor,
      currency: sms.currency,
      kind: sms.kind,
      hold: sms.hold,
    },
  };
}

// Chinese and English grammar side by side; the Chinese words are what users type, not UI copy.
const PAY_VERB = "(?:付了|付的|付|paid\\b)";
const TREAT_VERB = "(?:请客|请了|请|treated\\b|treats\\b|['’]s\\s+treat\\b)";
const USD_WORDS = "usd\\b|dollars?\\b|bucks?\\b|美元|美金|刀";
const CNY_WORDS = "rmb\\b|cny\\b|yuan\\b|人民币|块钱|块|元";
/** "all @X" / "for @X" (English) next to 全给 / 全算 / 全是 / 帮: X bears the whole amount. */
const FULL_PREFIX = "(?:全给|全算|全是|帮|\\ball\\s+|\\bfor\\s+)";
const EN_WEEKDAYS: Record<string, number> = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 };
const EN_WEEKDAY_RE = /\b(sun|mon|tue|wed|thu|fri|sat)(?:day|s|sday|nesday|rsday|r|rs|urday)?\b/i;
const EN_RELATIVE: Record<string, number> = { today: 0, yesterday: 1 };
const QUANTIFIERS = "个|件|斤|杯|瓶|份|次|张|人|位|盒|包|袋|天|晚|号|点";
const WEEKDAYS = "一二三四五六日天";

const CATEGORY_HINTS: ReadonlyArray<readonly [RegExp, string]> = [
  [/房租|租金|电费|水费|燃气|煤气|网费|宽带|物业|水电|话费|\brent\b|utilit|internet|electric/i, "居住"],
  [/买菜|超市|盒马|叮咚|水果|costco|trader\s?joe|walmart|h\s?mart|99\s?ranch|weee|grocer/i, "买菜"],
  [/吃|饭|餐|火锅|外卖|咖啡|奶茶|烧烤|烤肉|饺子|面馆|拉面|lunch|dinner|breakfast|brunch|coffee|pizza/i, "餐饮"],
  [/菜/, "买菜"],
  [/打车|滴滴|\buber\b|\blyft\b|地铁|公交|加油|油费|停车|高速/i, "交通"],
  [/日用|纸巾|洗衣|清洁|洗洁精/, "日用"],
  [/电影|ktv|游戏|门票|演出|演唱会/i, "娱乐"],
  [/药|医院|诊所|看病/, "医疗"],
  [/机票|酒店|民宿|airbnb|hotel/i, "旅行"],
];

function normalize(text: string): string {
  return text
    .replace(/[\uFF01-\uFF5E]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xfee0))
    .replace(/\uFFE5/g, "¥")
    .replace(/[\u3000\s]+/g, " ")
    .replace(/[\uFF0C\u3002\u3001\uFF1B]/g, " ")
    .trim();
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

function dayNumber(date: string): number {
  const [y, m, d] = date.split("-").map(Number);
  return Date.UTC(y ?? 0, (m ?? 1) - 1, d ?? 1) / 86_400_000;
}

function fromDayNumber(n: number): string {
  return new Date(n * 86_400_000).toISOString().slice(0, 10);
}

function invalidDate(value: string): QuickError {
  return { code: "quick_invalid_date", message: `Invalid date: ${value}`, params: { value } };
}

/** Most recent past `dow` (0 = Sunday), never today. */
function lastWeekday(today: string, dow: number): string {
  const todayDow = new Date(dayNumber(today) * 86_400_000).getUTCDay();
  const back = (todayDow - dow + 7) % 7 || 7;
  return fromDayNumber(dayNumber(today) - back);
}

function validDate(y: number, m: number, d: number): string | null {
  const iso = `${y}-${pad2(m)}-${pad2(d)}`;
  if (m < 1 || m > 12 || d < 1 || d > 31) return null;
  return fromDayNumber(dayNumber(iso)) === iso ? iso : null;
}

interface Key {
  key: string;
  participant: QuickParticipant;
}

function keysOf(participants: readonly QuickParticipant[]): Key[] {
  const out: Key[] = [];
  for (const p of participants) {
    for (const k of [p.name, ...(p.aliases ?? [])]) {
      const key = normalize(k);
      if (key) out.push({ key, participant: p });
    }
  }
  // Longest first so "小王八" beats "小王"; stable for equal length (keeps caller's preference order).
  return out.sort((a, b) => b.key.length - a.key.length);
}

/**
 * Parses a one-line quick entry such as "@室友 付 80 电费", "昨天 盒马 $45.2 @小王", "帮@小李 带饭 25元",
 * "lunch 35 @roommate", "yesterday groceries 120 @A @B" or "@roommate paid 80 utilities".
 * Tolerant: any order, unknown bits become the description.
 */
export function parseQuickEntry(text: string, ctx: QuickParseContext): QuickDraft {
  const sms = parseSmsEntry(text, ctx);
  if (sms) return sms;
  let s = ` ${normalize(text)} `;
  const errors: QuickError[] = [];
  const keys = keysOf(ctx.participants);
  const lower = (k: string) => k.toLowerCase();

  /** Finds the first match, blanks it out of `s`, returns the match. */
  const take = (re: RegExp): RegExpExecArray | null => {
    const m = re.exec(s);
    if (m) s = s.slice(0, m.index) + " " + s.slice(m.index + m[0].length);
    return m;
  };

  /** Longest participant key that `token` starts with, else a unique-ish fuzzy prefix match. */
  const resolveToken = (token: string): { participant: QuickParticipant; used: string } | null => {
    const t = lower(token);
    for (const k of keys) if (t.startsWith(lower(k.key))) return { participant: k.participant, used: token.slice(0, k.key.length) };
    const head = token.replace(/[\d.¥$].*$/, "");
    if (head.length === 0) return null;
    const fuzzy = keys
      .filter((k) => lower(k.key).startsWith(lower(head)))
      .sort((a, b) => ctx.participants.indexOf(a.participant) - ctx.participants.indexOf(b.participant))[0];
    return fuzzy ? { participant: fuzzy.participant, used: head } : null;
  };

  const unknown = (name: string) => {
    if (!errors.some((e) => e.code === "quick_unknown_participant" && e.name === name)) {
      errors.push({ code: "quick_unknown_participant", message: `Unknown participant: ${name}`, params: { name }, name });
    }
  };

  // --- date ---
  const today = ctx.today;
  const [ty] = today.split("-").map(Number);
  let date = today;
  let m: RegExpExecArray | null;
  if ((m = take(/(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/))) {
    const d = validDate(Number(m[1]), Number(m[2]), Number(m[3]));
    if (d) date = d;
    else errors.push(invalidDate(m[0]));
  } else if ((m = take(/(\d{1,2})月(\d{1,2})[日号]?/)) || (m = take(/(?<![\d.$¥])(\d{1,2})[-/](\d{1,2})(?![\d.])/))) {
    let d = validDate(ty ?? 1970, Number(m[1]), Number(m[2]));
    if (d && d > today) d = validDate((ty ?? 1970) - 1, Number(m[1]), Number(m[2]));
    if (d) date = d;
    else errors.push(invalidDate(m[0].trim()));
  } else if ((m = take(/大前天|前天|昨天|今天/))) {
    const back = { 今天: 0, 昨天: 1, 前天: 2, 大前天: 3 }[m[0] as "今天"] ?? 0;
    date = fromDayNumber(dayNumber(today) - back);
  } else if ((m = take(/\b(today|yesterday)\b/i))) {
    date = fromDayNumber(dayNumber(today) - (EN_RELATIVE[m[1]!.toLowerCase()] ?? 0));
  } else if ((m = take(new RegExp(`(?:周|星期|礼拜)([${WEEKDAYS}])`)))) {
    date = lastWeekday(today, (WEEKDAYS.indexOf(m[1]!) + 1) % 7); // 0 = Sunday
  } else if ((m = take(new RegExp(`(?:\\blast\\s+|\\bon\\s+)?${EN_WEEKDAY_RE.source}`, "i")))) {
    date = lastWeekday(today, EN_WEEKDAYS[m[1]!.toLowerCase()] ?? 0);
  }

  const participantIds: number[] = [];
  const addParticipant = (p: QuickParticipant) => {
    if (!p.isSelf && !participantIds.includes(p.id)) participantIds.push(p.id);
  };
  let payerId: number | null = null;
  let mode: SplitMode = "equal";

  // --- full mode: 全给@X / 帮@X / 帮X / all @X / for @X ---
  if ((m = take(new RegExp(`${FULL_PREFIX}\\s*@(\\S+)`, "i")))) {
    const r = resolveToken(m[1]!);
    if (r) {
      addParticipant(r.participant);
      mode = r.participant.isSelf ? "equal" : "full";
      s = s.slice(0, m.index) + " " + m[1]!.slice(r.used.length) + s.slice(m.index + 1);
    } else unknown(m[1]!.replace(/[\d.¥$].*$/, "") || m[1]!);
  } else {
    for (const k of keys) {
      if (take(new RegExp(`${FULL_PREFIX}\\s*${escapeRe(k.key)}`, "i"))) {
        addParticipant(k.participant);
        if (!k.participant.isSelf) mode = "full";
        break;
      }
    }
  }

  // --- 「X 请」 / "X treated" / "X's treat" means X treated me: no debt either way, so it is rejected with a hint ---
  for (const k of keys) {
    if (take(new RegExp(`@?${escapeRe(k.key)}\\s*${TREAT_VERB}`, "i"))) {
      const name = k.participant.name;
      errors.push({
        code: "quick_treat",
        message: `"${name} treated" is a treat and creates no split; if they paid first and it should be shared, write "${name} paid"`,
        params: { name },
      });
      break;
    }
  }

  // --- payer: @X 付 / X付了 / @X paid / X paid ---
  const setPayer = (p: QuickParticipant) => {
    if (p.isSelf) return;
    payerId = p.id;
    addParticipant(p);
  };
  if ((m = take(new RegExp(`@(\\S+?)\\s*${PAY_VERB}`, "i")))) {
    const r = resolveToken(m[1]!);
    if (r) {
      setPayer(r.participant);
      s = s.slice(0, m.index) + " " + m[1]!.slice(r.used.length) + s.slice(m.index + 1);
    } else unknown(m[1]!);
  } else {
    for (const k of keys) {
      if (take(new RegExp(`${escapeRe(k.key)}\\s*${PAY_VERB}`, "i"))) {
        setPayer(k.participant);
        break;
      }
    }
  }
  if (payerId !== null && mode === "full") mode = "equal"; // "full" means I fronted it; not with a friend payer

  // --- amount ---
  let amountText: string | null = null;
  let currency: string | null = null;
  const currencyOf = (word: string) => (new RegExp(`^(?:\\$|${USD_WORDS})$`, "i").test(word) ? "USD" : "CNY");
  if ((m = take(/([¥$])\s*(\d+(?:\.\d+)?)/))) {
    currency = currencyOf(m[1]!);
    amountText = m[2]!;
  } else if ((m = take(new RegExp(`(\\d+(?:\\.\\d+)?)\\s*(${USD_WORDS}|${CNY_WORDS})`, "i")))) {
    currency = currencyOf(m[2]!);
    amountText = m[1]!;
  } else if ((m = take(new RegExp(`(?<![\\w.@])(\\d+(?:\\.\\d+)?)(?![\\w.]|\\s*(?:${QUANTIFIERS}))`)))) {
    amountText = m[1]!;
  }
  currency ??= ctx.defaultCurrency.toUpperCase();
  let amountMinor: number | null = null;
  if (amountText === null) {
    errors.push({ code: "quick_missing_amount", message: "No amount found", params: {} });
  } else {
    try {
      amountMinor = parseAmountToMinor(amountText, minorDigits(currency));
      if (amountMinor <= 0) {
        errors.push({ code: "quick_amount_not_positive", message: "The amount must be greater than 0", params: {} });
        amountMinor = null;
      }
    } catch {
      errors.push({ code: "quick_invalid_amount", message: `Invalid amount: ${amountText}`, params: { value: amountText } });
    }
  }

  // --- remaining @mentions ---
  while ((m = /@(\S*)/.exec(s))) {
    const token = m[1]!;
    const r = token ? resolveToken(token) : null;
    if (r) {
      addParticipant(r.participant);
      s = s.slice(0, m.index) + " " + token.slice(r.used.length) + s.slice(m.index + m[0].length);
    } else {
      const name = token.replace(/[\d.¥$].*$/, "") || token;
      if (name) unknown(name);
      s = s.slice(0, m.index) + " " + token.slice(name.length) + s.slice(m.index + m[0].length);
    }
  }

  // --- bare participant names (CJK names of 2+ chars anywhere; latin names as whole words) ---
  for (const k of keys) {
    if (k.participant.isSelf) continue;
    const latin = /^[\w .-]+$/.test(k.key);
    if (!latin && k.key.length < 2) continue;
    const re = latin ? new RegExp(`(?<![\\w])${escapeRe(k.key)}(?![\\w])`, "i") : new RegExp(escapeRe(k.key));
    if (take(re)) addParticipant(k.participant);
  }

  const description = s
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^(?:和|跟|与|同|(?:with|and)\b)\s*/i, "")
    .replace(/\s*(?:和|跟|与|同|\b(?:with|and))$/i, "")
    .replace(new RegExp(`^${PAY_VERB}\\s+|\\s+${PAY_VERB}$`, "g"), "")
    .replace(/^[,.:;!?\-~]+|[,.:;!?\-~]+$/g, "")
    .trim();

  const categoryHint = CATEGORY_HINTS.find(([re]) => re.test(description))?.[1] ?? null;

  return { amountMinor, currency, description, date, participantIds, payerId, mode, categoryHint, errors };
}
