import { categories, participants, transactions, transactionSplits } from "@yomi/db";
import { and, eq, inArray } from "@yomi/db/orm";
import { formatMinor } from "../money";
import { contactParts, type PaymentKind, paymentTitle, type StatementPayment, statementPayments } from "../payment";
import { getPaymentMethods, getProfileContact } from "../settings/payment";
import { getDisplayName } from "../settings/profile";
import type { CurrentUser } from "../user";
import { type AaEvent, aaAccounts, aaEvents } from "./balances";
import { coverageOf, type ItemStatus, itemRowsOf, settledOnDates } from "./items";
import { addDays } from "../time/day";
import { assertCurrency, assertDate, getParticipant, type Q, SplitError, todayLocal } from "./internal";

/**
 * What a statement shows besides the items themselves; shared by the text, the print view, the dialog and the CSV.
 * shared: how many people split an item ("split 3 ways"), only when someone besides me and the recipient is in it.
 * names: also who they are (implies shared). myshare: my own share per item. notes: the shared note. settlements:
 * the settlements in the window. category: the item's category. payment: "My payment details", the user's payment
 * methods for the statement's currency (Settings > Profile), when there is something to pay.
 */
export const STATEMENT_FLAGS = ["shared", "names", "myshare", "notes", "settlements", "category", "payment"] as const;
export type StatementFlag = (typeof STATEMENT_FLAGS)[number];
/** Flags applied when none are given: third parties' names stay off a statement meant for someone else. */
export const DEFAULT_STATEMENT_FLAGS: readonly StatementFlag[] = ["shared", "notes", "settlements", "payment"];

/** Known flags only, in canonical order; "names" brings "shared" with it. */
export function normalizeStatementFlags(flags: readonly string[]): StatementFlag[] {
  const set = new Set(flags);
  if (set.has("names")) set.add("shared");
  return STATEMENT_FLAGS.filter((f) => set.has(f));
}

/** Days of settlements the statement lists after the open items, unless `recentSince` is given. */
export const STATEMENT_RECENT_DAYS = 60;

export interface StatementItem {
  transactionId: number;
  date: string;
  merchant: string;
  totalMinor: number;
  /** The participant's share of the item. */
  theirShareMinor: number;
  /** True when the participant paid for the item (friend-paid). */
  paidByThem: boolean;
  deltaMinor: number;
  /** People with a share of the item, me included. */
  splitCount: number;
  /** The others with a share, besides me and this participant. */
  sharedWith: string[];
  /** My own share of the item, signed like theirShareMinor. */
  myShareMinor: number;
  /** Stored category name, null when uncategorized. */
  category: string | null;
}

export interface StatementSettlement {
  settlementId: number;
  date: string;
  amountMinor: number;
  originalAmountMinor: number | null;
  originalCurrency: string | null;
  note: string | null;
}

/** A split item with its settlement status. remainingMinor is what is still open (0 when covered). */
export interface StatementEntry extends StatementItem {
  remainingMinor: number;
  status: ItemStatus;
  sharedNote: string | null;
  /** Day the item became settled for good (covered items only). */
  settledOn: string | null;
}

/** Which items a statement covers: open ones (default), every item, or the ones picked by id. */
export type StatementScope = "open" | "all" | "selected";

export interface StatementRecentSettlement extends StatementSettlement {
  fxRate: string | null;
  /** Items this settlement named, with the part of each it paid. */
  items: (StatementEntry & { paidMinor: number })[];
}

export interface Statement {
  participantId: number;
  participantName: string;
  /** The user's display name (Settings > Profile), or null; labels my share as "Sam's share". */
  myName: string | null;
  currency: string;
  /** Running-account window (CSV export): first day covered, null when the window is empty. */
  since: string | null;
  /** Window: balance before it (non-zero only when `since` cuts into an open stretch). */
  openingMinor: number;
  /** Window: opening balances recorded inside it, signed like deltas (+ they owe me). */
  openingBalanceMinor: number;
  /** Window: split rows. */
  items: StatementItem[];
  /** Window: payments. */
  settlements: StatementSettlement[];
  /** Split items not yet paid (status open or partial), oldest first. */
  openItems: StatementEntry[];
  /** Opening balances still open, signed like the balance. */
  openOpeningMinor: number;
  /** Paid but matched to no item, signed like the balance (negative: they paid ahead). */
  unmatchedMinor: number;
  /** First day of the recent-settlements list. */
  recentSince: string;
  /** Payments on or after recentSince, newest first, each with the items it named. */
  recentSettlements: StatementRecentSettlement[];
  balanceMinor: number;
  /** Every split item with this person in this currency, oldest first (open, partial and covered). */
  entries: StatementEntry[];
  scope: StatementScope;
  /** The items in scope, oldest first: open items, every entry, or the selected ones. */
  scopeItems: StatementEntry[];
  /** Sum of what is still open on the items in scope, signed like the balance. */
  scopeRemainingMinor: number;
  /** Sum of the full effect of the items in scope, signed like the balance. */
  scopeDeltaMinor: number;
  /** What the outputs show, normalized. */
  show: StatementFlag[];
  /**
   * "My payment details": the methods switched on for this currency, with links carrying the amount due where the service
   * documents one. Empty when the payment flag is off or nothing is due from them (balance, or the selected items).
   */
  payment: StatementPayment[];
  text: string;
}

/** Language of the statement text; the roommate may read Chinese while the UI is English, or the reverse. */
export type StatementLocale = "en" | "zh-CN";

interface StatementWords {
  header: (name: string, currency: string) => string;
  opening: string;
  theyOwe: (amount: string) => string;
  iOwe: (amount: string) => string;
  even: string;
  openTitle: string;
  settledTitle: string;
  settledOn: (date: string) => string;
  scopeLine: (scope: StatementScope, count: number) => string;
  scopeTotal: string;
  item: (date: string, merchant: string, total: string, paidByThem: boolean, share: string) => string;
  partial: (left: string) => string;
  splitWays: (count: number, names: readonly string[] | null) => string;
  /** My share of an item: "my share $x", or "Sam's share $x" once a display name is set. */
  myShare: (amount: string, myName: string | null) => string;
  category: (name: string) => string;
  note: string;
  paidAhead: (toMe: boolean, amount: string) => string;
  recentTitle: string;
  settlement: (date: string, toMe: boolean, amount: string, original: string | null, rate: string | null) => string;
  covers: string;
  coveredItem: (date: string, merchant: string, amount: string) => string;
  empty: string;
  total: string;
  payTitle: string;
  payKinds: Record<PaymentKind, string>;
  payQrOnly: string;
}

const mmdd = (date: string) => date.slice(5, 10);
const md = (date: string) => `${Number(date.slice(5, 7))}/${Number(date.slice(8, 10))}`;

/** Seeded system categories are stored in Chinese; the English text names them in English. */
const EN_CATEGORIES: Record<string, string> = {
  餐饮: "Dining",
  买菜: "Groceries",
  交通: "Transport",
  购物: "Shopping",
  日用: "Household",
  居住: "Housing",
  娱乐: "Entertainment",
  订阅: "Subscriptions",
  医疗: "Medical",
  教育: "Education",
  旅行: "Travel",
  人情: "Gifts and transfers",
  公益: "Charity",
  其他: "Other",
  退款: "Refunds",
};

/** A stored category name in the statement's language. */
export function statementCategory(name: string, locale: StatementLocale): string {
  return locale === "en" ? (EN_CATEGORIES[name] ?? name) : name;
}

const WORDS: Record<StatementLocale, StatementWords> = {
  en: {
    header: (name, c) => `Shared expenses with ${name} (${c})`,
    opening: "Opening balance: ",
    theyOwe: (a) => `you owe me ${a}`,
    iOwe: (a) => `I owe you ${a}`,
    even: "all square",
    openTitle: "Not settled yet:",
    settledTitle: "Already settled:",
    settledOn: (d) => ` (settled on ${md(d)})`,
    scopeLine: (sc, n) => (sc === "all" ? "All items" : sc === "selected" ? `Selected ${n} ${n === 1 ? "item" : "items"}` : "Open items only"),
    scopeTotal: "These items: ",
    item: (d, m, total, paidByThem, share) =>
      `${md(d)} ${m || "(no description)"} ${total}${paidByThem ? ", you paid" : ""}, your share ${share}`,
    partial: (left) => ` (partly settled, ${left} left)`,
    splitWays: (n, names) => `, split ${n} ways${names && names.length > 0 ? ` (with ${names.join(", ")})` : ""}`,
    myShare: (a, me) => (me ? `, ${me}'s share ${a}` : `, my share ${a}`),
    category: (name) => ` [${statementCategory(name, "en")}]`,
    note: "  Note: ",
    paidAhead: (toMe, a) => `Paid ahead, not matched to an item: ${toMe ? "you sent me" : "I sent you"} ${a}`,
    recentTitle: "Settled recently:",
    settlement: (d, toMe, a, orig, rate) =>
      `${md(d)} ${toMe ? "you sent me" : "I sent you"} ${a}${orig ? ` (actually ${orig}${rate ? ` at ${rate}` : ""})` : ""}`,
    covers: "  Covers:",
    coveredItem: (d, m, a) => `  - ${md(d)} ${m || "(no description)"} ${a}`,
    empty: "Nothing is open.",
    total: "Total: ",
    payTitle: "My payment details:",
    payKinds: { zelle: "Zelle", venmo: "Venmo", paypal: "PayPal", cashapp: "Cash App", alipay: "Alipay", wechat: "WeChat Pay", other: "Other" },
    payQrOnly: "QR code in the PDF",
  },
  "zh-CN": {
    header: (name, c) => `和${name}的AA账单（${c}）`,
    opening: "期初余额：",
    theyOwe: (a) => `你欠我 ${a}`,
    iOwe: (a) => `我欠你 ${a}`,
    even: "已结清",
    openTitle: "未结清：",
    settledTitle: "已结清：",
    settledOn: (d) => `（${mmdd(d)} 已结清）`,
    scopeLine: (sc, n) => (sc === "all" ? "全部账目" : sc === "selected" ? `所选 ${n} 笔` : "仅未结清账目"),
    scopeTotal: "这些账目合计：",
    item: (d, m, total, paidByThem, share) => `${mmdd(d)} ${m || "（无描述）"} 共${total}${paidByThem ? "，你付的" : ""}，你的份额 ${share}`,
    partial: (left) => `（已结一部分，还剩 ${left}）`,
    splitWays: (n, names) => `，${n} 人分摊${names && names.length > 0 ? `（和 ${names.join("、")}）` : ""}`,
    myShare: (a, me) => (me ? `，${me}的份额 ${a}` : `，我的份额 ${a}`),
    category: (name) => `［${name}］`,
    note: "  备注：",
    paidAhead: (toMe, a) => `预付，未对应到账目：${toMe ? "你转我" : "我转你"} ${a}`,
    recentTitle: "最近结算：",
    settlement: (d, toMe, a, orig, rate) =>
      `${mmdd(d)} ${toMe ? "你转我" : "我转你"} ${a}${orig ? `（实际 ${orig}${rate ? `，汇率 ${rate}` : ""}）` : ""}`,
    covers: "  包含：",
    coveredItem: (d, m, a) => `  - ${mmdd(d)} ${m || "（无描述）"} ${a}`,
    empty: "没有未结清的账目。",
    total: "合计：",
    payTitle: "我的收款信息：",
    payKinds: { zelle: "Zelle", venmo: "Venmo", paypal: "PayPal", cashapp: "Cash App", alipay: "支付宝", wechat: "微信支付", other: "其他" },
    payQrOnly: "二维码见 PDF",
  },
};

interface ItemDetails {
  splitCount: number;
  sharedWith: string[];
  myShareMinor: number;
  category: string | null;
}

/** Who else shares each item, my own share and its category, for the transactions given. */
async function itemDetails(db: Q, user: CurrentUser, participantId: number, currency: string, ids: readonly number[]): Promise<Map<number, ItemDetails>> {
  const out = new Map<number, ItemDetails>();
  if (ids.length === 0) return out;
  const unique = [...new Set(ids)];
  const rows: {
    transactionId: number;
    participantId: number;
    name: string;
    isSelf: boolean;
    owedMinor: number;
    amountMinor: number;
    category: string | null;
  }[] = [];
  for (let i = 0; i < unique.length; i += 500) {
    rows.push(
      ...await db
        .select({
          transactionId: transactionSplits.transactionId,
          participantId: transactionSplits.participantId,
          name: participants.name,
          isSelf: participants.isSelf,
          owedMinor: transactionSplits.owedMinor,
          amountMinor: transactions.amountMinor,
          category: categories.name,
        })
        .from(transactionSplits)
        .innerJoin(transactions, eq(transactions.id, transactionSplits.transactionId))
        .innerJoin(participants, eq(participants.id, transactionSplits.participantId))
        .leftJoin(categories, eq(categories.id, transactions.categoryId))
        .where(
          and(
            eq(transactionSplits.userId, user.id),
            eq(transactionSplits.currency, currency),
            inArray(transactionSplits.transactionId, unique.slice(i, i + 500)),
          ),
        )
        .orderBy(transactionSplits.id)
        ,
    );
  }
  for (const r of rows) {
    let d = out.get(r.transactionId);
    if (!d) out.set(r.transactionId, (d = { splitCount: 0, sharedWith: [], myShareMinor: 0, category: r.category }));
    if (r.owedMinor === 0) continue;
    d.splitCount += 1;
    // Same sign convention as aaEvents: a refund runs the other way.
    if (r.isSelf) d.myShareMinor = (r.amountMinor > 0 ? -1 : 1) * r.owedMinor;
    else if (r.participantId !== participantId) d.sharedWith.push(r.name);
  }
  return out;
}

const NO_DETAILS: ItemDetails = { splitCount: 0, sharedWith: [], myShareMinor: 0, category: null };

function balanceSentence(w: StatementWords, balance: number, currency: string): string {
  if (balance > 0) return w.theyOwe(formatMinor(balance, currency));
  if (balance < 0) return w.iOwe(formatMinor(-balance, currency));
  return w.even;
}

/**
 * The statement for one person in one currency: what is still open (split items not covered by a settlement, see
 * items.ts), then the settlements of the last STATEMENT_RECENT_DAYS days with the items each one paid. `text` is
 * written to the participant ("you") in `locale` (default English), ready to paste into WeChat.
 *
 * The window fields (since, openingMinor, openingBalanceMinor, items, settlements) keep the running-account view
 * the CSV export uses: every event after the last time the balance was zero, or from `since`.
 */
export async function statementText(
  db: Q,
  user: CurrentUser,
  participantId: number,
  currency: string,
  opts: {
    since?: string;
    recentSince?: string;
    today?: string;
    locale?: StatementLocale;
    /** Default "open". "all" also widens the CSV window to the whole history (unless `since` is given). */
    scope?: StatementScope;
    /** Transaction ids for scope "selected": split items with this person in this currency. */
    itemIds?: readonly number[];
    /** What to show (see STATEMENT_FLAGS); default DEFAULT_STATEMENT_FLAGS. */
    show?: readonly string[];
  } = {},
): Promise<Statement> {
  const p = await getParticipant(db, user, participantId);
  if (p.isSelf) throw new SplitError("invalid", "statement_self", "\"Me\" has no statement");
  const c = assertCurrency(currency);
  const events = (await aaEvents(db, user, participantId)).filter((e) => e.currency === c);
  const account = aaAccounts(events)[0];
  const balance = account?.balanceMinor ?? 0;

  let windowEvents: AaEvent[];
  let opening = 0;
  if (opts.since) {
    const since = assertDate(opts.since);
    windowEvents = events.filter((e) => e.date >= since);
    opening = events.filter((e) => e.date < since).reduce((s, e) => s + e.deltaMinor, 0);
  } else if (opts.scope === "all") {
    windowEvents = events;
  } else {
    windowEvents = account?.open ?? [];
  }

  const details = await itemDetails(
    db,
    user,
    participantId,
    c,
    events.flatMap((e) => (e.type === "split" ? [e.transactionId] : [])),
  );
  const detailsOf = (id: number) => {
    const d = details.get(id) ?? NO_DETAILS;
    return { ...d, sharedWith: [...d.sharedWith] };
  };
  const items: StatementItem[] = [];
  const settled: StatementSettlement[] = [];
  let openingBalance = 0;
  for (const e of windowEvents) {
    if (e.type === "settlement" && e.opening) {
      openingBalance += e.deltaMinor;
    } else if (e.type === "split") {
      items.push({
        transactionId: e.transactionId,
        date: e.date,
        merchant: e.merchant,
        totalMinor: e.totalMinor,
        theirShareMinor: e.owedMinor,
        paidByThem: e.paidMinor !== 0,
        deltaMinor: e.deltaMinor,
        ...detailsOf(e.transactionId),
      });
    } else {
      settled.push({
        settlementId: e.settlementId,
        date: e.date,
        amountMinor: e.amountMinor,
        originalAmountMinor: e.originalAmountMinor,
        originalCurrency: e.originalCurrency,
        note: e.note,
      });
    }
  }

  // Item view.
  const rows = await itemRowsOf(db, user, participantId, c);
  const cov = coverageOf(events, rows);
  const settledOn = settledOnDates(events, rows);
  const entryOf = new Map<number, StatementEntry>();
  const entries: StatementEntry[] = [];
  const openItems: StatementEntry[] = [];
  let openOpening = 0;
  for (const e of cov.entries) {
    if (e.event.type !== "split") {
      openOpening += e.remainingMinor;
      continue;
    }
    const entry: StatementEntry = {
      transactionId: e.event.transactionId,
      date: e.date,
      merchant: e.event.merchant,
      totalMinor: e.event.totalMinor,
      theirShareMinor: e.event.owedMinor,
      paidByThem: e.event.paidMinor !== 0,
      deltaMinor: e.deltaMinor,
      ...detailsOf(e.event.transactionId),
      remainingMinor: e.remainingMinor,
      status: e.status,
      sharedNote: e.event.sharedNote,
      settledOn: e.status === "covered" ? (settledOn.get(e.event.transactionId) ?? null) : null,
    };
    entryOf.set(entry.transactionId, entry);
    entries.push(entry);
    if (e.status !== "covered") openItems.push(entry);
  }
  const recentSince = opts.recentSince ? assertDate(opts.recentSince) : addDays(opts.today ?? todayLocal(), -STATEMENT_RECENT_DAYS);
  const recent: StatementRecentSettlement[] = events
    .filter((e): e is Extract<AaEvent, { type: "settlement" }> => e.type === "settlement" && !e.opening && e.date >= recentSince)
    .reverse()
    .map((e) => ({
      settlementId: e.settlementId,
      date: e.date,
      amountMinor: e.amountMinor,
      originalAmountMinor: e.originalAmountMinor,
      originalCurrency: e.originalCurrency,
      fxRate: e.fxRate,
      note: e.note,
      items: (cov.itemsBySettlement.get(e.settlementId) ?? [])
        .map((r) => {
          const entry = entryOf.get(r.transactionId);
          return entry ? { ...entry, paidMinor: r.amountMinor } : null;
        })
        .filter((x): x is StatementEntry & { paidMinor: number } => x !== null)
        .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.transactionId - b.transactionId)),
    }));

  const scope = opts.scope ?? "open";
  let scopeItems: StatementEntry[];
  if (scope === "selected") {
    const ids = new Set(opts.itemIds ?? []);
    if (ids.size === 0) throw new SplitError("invalid", "statement_items_required", "Choose at least one item for the statement");
    const unknown = [...ids].filter((id) => !entryOf.has(id));
    if (unknown.length > 0) {
      throw new SplitError("invalid", "statement_items_invalid", `Not split with ${p.name} in ${c}: ${unknown.join(", ")}`, {
        count: unknown.length,
      });
    }
    scopeItems = entries.filter((e) => ids.has(e.transactionId));
  } else {
    scopeItems = scope === "all" ? entries : openItems;
  }
  const scopeRemaining = scopeItems.reduce((sum, e) => sum + e.remainingMinor, 0);
  const scopeDelta = scopeItems.reduce((sum, e) => sum + e.deltaMinor, 0);

  const show = normalizeStatementFlags(opts.show ?? DEFAULT_STATEMENT_FLAGS);
  const on = (f: StatementFlag) => show.includes(f);
  const w = WORDS[opts.locale ?? "en"];
  const myName = await getDisplayName(db, user);
  const lines: string[] = [w.header(p.name, c)];
  const itemLines = (list: StatementEntry[]) => {
    for (const it of list) {
      const merchant = on("category") && it.category ? it.merchant + w.category(it.category) : it.merchant;
      let line = w.item(it.date, merchant, formatMinor(it.totalMinor, c), it.paidByThem, formatMinor(it.theirShareMinor, c));
      if (on("myshare")) line += w.myShare(formatMinor(it.myShareMinor, c), myName);
      if (on("shared") && it.sharedWith.length > 0) line += w.splitWays(it.splitCount, on("names") ? it.sharedWith : null);
      if (it.status === "partial") line += w.partial(formatMinor(Math.abs(it.remainingMinor), c));
      if (it.status === "covered" && it.settledOn) line += w.settledOn(it.settledOn);
      lines.push(line);
      if (on("notes") && it.sharedNote) lines.push(w.note + it.sharedNote);
    }
  };
  if (scope !== "open") lines.push(w.scopeLine(scope, scopeItems.length));
  const scopeOpen = scopeItems.filter((e) => e.status !== "covered");
  const scopeSettled = scopeItems.filter((e) => e.status === "covered");
  if (scope !== "selected" && openOpening !== 0) lines.push(w.opening + balanceSentence(w, openOpening, c));
  if (scopeOpen.length > 0) {
    lines.push("", w.openTitle);
    itemLines(scopeOpen);
  }
  if (scopeSettled.length > 0) {
    lines.push("", w.settledTitle);
    itemLines(scopeSettled);
  }
  if (scope === "selected") {
    lines.push("", w.scopeTotal + balanceSentence(w, scopeRemaining, c));
  } else {
    if (cov.unmatchedMinor !== 0) lines.push("", w.paidAhead(cov.unmatchedMinor < 0, formatMinor(Math.abs(cov.unmatchedMinor), c)));
    if (openItems.length === 0 && openOpening === 0 && cov.unmatchedMinor === 0) lines.push("", w.empty);
  }
  if (scope !== "selected" && on("settlements") && recent.length > 0) {
    lines.push("", w.recentTitle);
    for (const s of recent) {
      const orig =
        s.originalAmountMinor !== null && s.originalCurrency ? formatMinor(Math.abs(s.originalAmountMinor), s.originalCurrency) : null;
      lines.push(w.settlement(s.date, s.amountMinor > 0, formatMinor(Math.abs(s.amountMinor), c), orig, s.fxRate));
      if (s.items.length > 0) {
        lines.push(w.covers);
        for (const it of s.items) lines.push(w.coveredItem(it.date, it.merchant, formatMinor(Math.abs(it.paidMinor), c)));
      }
    }
  }
  lines.push("", w.total + balanceSentence(w, balance, c));

  const due = scope === "selected" ? scopeRemaining : balance;
  const payment = on("payment") && due > 0 ? statementPayments(await getPaymentMethods(db, user), c, due, await getProfileContact(db, user)) : [];
  if (payment.length > 0) {
    lines.push("", w.payTitle);
    for (const m of payment) {
      const parts = contactParts(m, c);
      lines.push(`${paymentTitle(m.kind, w.payKinds[m.kind], m.label)}: ${parts.length > 0 ? parts.join("  ") : w.payQrOnly}`);
    }
  }

  return {
    participantId: p.id,
    participantName: p.name,
    myName,
    currency: c,
    since: opts.since ?? windowEvents[0]?.date ?? null,
    openingMinor: opening,
    openingBalanceMinor: openingBalance,
    items,
    settlements: settled,
    openItems,
    openOpeningMinor: openOpening,
    unmatchedMinor: cov.unmatchedMinor,
    recentSince,
    recentSettlements: recent,
    balanceMinor: balance,
    entries,
    scope,
    scopeItems,
    scopeRemainingMinor: scopeRemaining,
    scopeDeltaMinor: scopeDelta,
    show,
    payment,
    text: lines.join("\n"),
  };
}
