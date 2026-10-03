import { accounts, type CaptureKind, captures, type CaptureState, categories, type Db, participants, transactions, transactionSplits } from "@yomi/db";
import { and, count, desc, eq, gte, inArray, isNull, like, lt, lte, ne, or, type SQL, sql } from "@yomi/db/orm";
import { parseAmountToMinor } from "../money";
import type { CurrentUser } from "../user";
import { LedgerError } from "./errors";
import { countsAsSpending, isMonth, monthRange, myShareMinor } from "./share";
import { addDays, isDate } from "../stats/period";
import { unsplitConditions } from "./unsplit";
import { type SplitSuggestion, suggestSplits } from "../split/suggest";

export type TransactionKind = "expense" | "income" | "transfer" | "refund";

export interface TransactionFilter {
  id?: number;
  /** "YYYY-MM" */
  month?: string;
  /** First day 'YYYY-MM-DD', inclusive. */
  from?: string;
  /** Last day 'YYYY-MM-DD', inclusive. */
  to?: string;
  /** Case-insensitive substring of merchant, counterparty, description or note; a number also matches |amount|. */
  q?: string;
  categoryId?: number;
  kind?: TransactionKind;
  /** Rows split with this participant. */
  participantId?: number;
  /** Non-transfer rows with no category or only the fallback 其他 / 其他收入 (Other / Other income). */
  uncategorized?: boolean;
  /** Unsplit expenses of my own accounts (see unsplit.ts): the backfill triage list. */
  unsplit?: boolean;
  limit?: number;
  offset?: number;
}

export interface SplitItem {
  participantId: number;
  name: string;
  isSelf: boolean;
  owedMinor: number;
  paidMinor: number;
}

export interface TransactionItem {
  id: number;
  occurredAt: string;
  /** Day of occurredAt in the user's time zone; lists group and filter by it. */
  occurredOn: string;
  amountMinor: number;
  currency: string;
  originalAmountMinor: number | null;
  originalCurrency: string | null;
  kind: TransactionKind;
  status: "ok" | "closed";
  merchant: string;
  counterpartyRaw: string;
  description: string;
  /** The statement's own classification (ICBC 摘要, WeChat 交易类型, Alipay 交易分类, ...), as imported. */
  sourceCategory: string | null;
  note: string | null;
  categoryId: number | null;
  categoryName: string | null;
  accountId: number | null;
  accountName: string | null;
  source: "alipay" | "wechat" | "icbc_pdf" | "plaid" | "boa_csv" | "sms" | "manual";
  importBatchId: number | null;
  duplicateOfId: number | null;
  userEditedAt: string | null;
  /** capture: from a pasted SMS no statement has confirmed yet (counted, labelled); hold: a card hold (not counted). */
  provisional: "capture" | "hold" | null;
  /** The capture behind this row (pasted SMS), for the details panel; null for rows that are not captures. */
  capture: CaptureInfo | null;
  splits: SplitItem[];
  /** What this row adds to my spending (plan §3); positive = spent, refunds negative, 0 if not counted. */
  myShareMinor: number;
  /** Suggested people for an unsplit expense row (same as suggestion.participantIds; empty otherwise). */
  suggestedParticipantIds: number[];
  /** The split suggestion (merchant rule, else the category's learned set), null when there is none. */
  suggestion: SplitSuggestion | null;
}

export interface CaptureInfo {
  id: number;
  kind: CaptureKind;
  state: CaptureState;
  /** As captured, with its own offset (ICBC SMS: Beijing time). */
  occurredAt: string;
  /** The statement row that confirmed or superseded it. */
  authorityId: number | null;
  authoritySource: TransactionItem["source"] | null;
  /** When it was confirmed, superseded, kept or discarded; null while provisional. */
  resolvedAt: string | null;
  /** Its last resolution can be undone. */
  canUndo: boolean;
}

export interface TransactionPage {
  items: TransactionItem[];
  total: number;
}

export interface MonthCount {
  month: string;
  count: number;
}

export interface CurrencyTotal extends ProvisionalTotals {
  currency: string;
  /** Rows counted as spending. */
  count: number;
  spendingMinor: number;
}

const DEFAULT_LIMIT = 500;
const MAX_LIMIT = 5000;
const CHUNK = 500;
const FALLBACK_CATEGORIES = ["其他", "其他收入"];

function chunks<T>(xs: readonly T[]): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < xs.length; i += CHUNK) out.push(xs.slice(i, i + CHUNK));
  return out;
}

function amountCandidates(q: string): number[] {
  if (!/^[-+]?[¥￥$]?\s*[\d,]*\.?\d+$/.test(q)) return [];
  try {
    const m = Math.abs(parseAmountToMinor(q));
    return m === 0 ? [] : [m, -m];
  } catch {
    return [];
  }
}

async function buildWhere(db: Db, userId: number, f: TransactionFilter): Promise<SQL> {
  const conds: (SQL | undefined)[] = [eq(transactions.userId, userId)];
  if (f.id !== undefined) conds.push(eq(transactions.id, f.id));
  if (f.month !== undefined) {
    if (!isMonth(f.month)) throw new LedgerError("invalid", "invalid_month", `Invalid month: ${f.month}`, { value: f.month });
    const { start, end } = monthRange(f.month);
    conds.push(gte(transactions.occurredOn, start), lt(transactions.occurredOn, end));
  }
  if (f.from !== undefined) {
    if (!isDate(f.from)) throw new LedgerError("invalid", "invalid_start_date", `Invalid start date: ${f.from}`, { value: f.from });
    conds.push(gte(transactions.occurredOn, f.from));
  }
  if (f.to !== undefined) {
    if (!isDate(f.to)) throw new LedgerError("invalid", "invalid_end_date", `Invalid end date: ${f.to}`, { value: f.to });
    conds.push(lte(transactions.occurredOn, f.to));
  }
  const q = f.q?.trim();
  if (q) {
    // `%` and `_` stay wildcards as they always were; a backslash is matched literally (Postgres LIKE escapes with it).
    const pattern = `%${q.toLowerCase().replace(/\\/g, "\\\\")}%`;
    const text = [transactions.merchant, transactions.counterpartyRaw, transactions.descriptionRaw, transactions.note].map(
      (col) => like(sql`lower(${col})`, pattern),
    );
    const amounts = amountCandidates(q);
    conds.push(or(...text, ...(amounts.length ? [inArray(transactions.amountMinor, amounts)] : [])));
  }
  if (f.categoryId !== undefined) conds.push(eq(transactions.categoryId, f.categoryId));
  if (f.kind !== undefined) conds.push(eq(transactions.kind, f.kind));
  if (f.participantId !== undefined) {
    conds.push(
      inArray(
        transactions.id,
        db
          .select({ id: transactionSplits.transactionId })
          .from(transactionSplits)
          .where(and(eq(transactionSplits.userId, userId), eq(transactionSplits.participantId, f.participantId))),
      ),
    );
  }
  if (f.uncategorized) {
    const fallbackIds = (await db
      .select({ id: categories.id })
      .from(categories)
      .where(and(eq(categories.userId, userId), eq(categories.isSystem, true), inArray(categories.name, FALLBACK_CATEGORIES)))
      )
      .map((c) => c.id);
    conds.push(ne(transactions.kind, "transfer"));
    conds.push(
      fallbackIds.length
        ? or(isNull(transactions.categoryId), inArray(transactions.categoryId, fallbackIds))
        : isNull(transactions.categoryId),
    );
  }
  if (f.unsplit) conds.push(...unsplitConditions(db, userId));
  return and(...conds)!;
}

/** Splits for the given rows, keyed by transaction id, self first. */
export async function loadSplits(db: Db, userId: number, ids: readonly number[]): Promise<Map<number, SplitItem[]>> {
  const out = new Map<number, SplitItem[]>();
  for (const part of chunks(ids)) {
    const rows = await db
      .select({
        transactionId: transactionSplits.transactionId,
        participantId: transactionSplits.participantId,
        name: participants.name,
        isSelf: participants.isSelf,
        owedMinor: transactionSplits.owedMinor,
        paidMinor: transactionSplits.paidMinor,
      })
      .from(transactionSplits)
      .innerJoin(participants, eq(participants.id, transactionSplits.participantId))
      .where(and(eq(transactionSplits.userId, userId), inArray(transactionSplits.transactionId, part)))
      .orderBy(desc(participants.isSelf), transactionSplits.participantId);
    for (const { transactionId, ...s } of rows) {
      const list = out.get(transactionId) ?? [];
      list.push(s);
      out.set(transactionId, list);
    }
  }
  return out;
}

/** The capture behind each of the given rows, keyed by transaction id. */
async function loadCaptures(db: Db, userId: number, ids: readonly number[]): Promise<Map<number, CaptureInfo>> {
  const out = new Map<number, CaptureInfo>();
  for (const part of chunks(ids)) {
    const rows = await db
      .select()
      .from(captures)
      .where(and(eq(captures.userId, userId), inArray(captures.transactionId, part)));
    const authorityIds = rows.flatMap((c) => (c.authorityId != null ? [c.authorityId] : []));
    const sources = new Map(
      authorityIds.length
        ? (await db.select({ id: transactions.id, source: transactions.source }).from(transactions).where(inArray(transactions.id, authorityIds))).map((t) => [t.id, t.source])
        : [],
    );
    for (const c of rows) {
      out.set(c.transactionId!, {
        id: c.id,
        kind: c.kind,
        state: c.state,
        occurredAt: c.occurredAt,
        authorityId: c.authorityId,
        authoritySource: c.authorityId != null ? (sources.get(c.authorityId) ?? null) : null,
        resolvedAt: c.resolvedAt,
        canUndo: (c.payload.undo ?? []).length > 0,
      });
    }
  }
  return out;
}

export async function listTransactions(db: Db, user: CurrentUser, filter: TransactionFilter = {}): Promise<TransactionPage> {
  const userId = user.id;
  const where = await buildWhere(db, userId, filter);
  const limit = Math.min(Math.max(filter.limit ?? DEFAULT_LIMIT, 1), MAX_LIMIT);
  const offset = Math.max(filter.offset ?? 0, 0);

  const rows = await db
    .select({
      id: transactions.id,
      occurredAt: transactions.occurredAt,
      occurredOn: transactions.occurredOn,
      amountMinor: transactions.amountMinor,
      currency: transactions.currency,
      originalAmountMinor: transactions.originalAmountMinor,
      originalCurrency: transactions.originalCurrency,
      kind: transactions.kind,
      status: transactions.status,
      merchant: transactions.merchant,
      counterpartyRaw: transactions.counterpartyRaw,
      description: transactions.descriptionRaw,
      sourceCategory: transactions.sourceCategory,
      note: transactions.note,
      categoryId: transactions.categoryId,
      categoryName: categories.name,
      accountId: transactions.accountId,
      accountName: accounts.name,
      source: transactions.source,
      importBatchId: transactions.importBatchId,
      duplicateOfId: transactions.duplicateOfId,
      userEditedAt: transactions.userEditedAt,
      provisional: transactions.provisional,
      splitSuggestionDismissedAt: transactions.splitSuggestionDismissedAt,
    })
    .from(transactions)
    .leftJoin(categories, eq(categories.id, transactions.categoryId))
    .leftJoin(accounts, eq(accounts.id, transactions.accountId))
    .where(where)
    .orderBy(desc(transactions.occurredOn), desc(transactions.occurredAt), desc(transactions.id))
    .limit(limit)
    .offset(offset);
  const total = (await db.select({ n: count() }).from(transactions).where(where).limit(1))[0]?.n ?? 0;

  const splits = await loadSplits(
    db,
    userId,
    rows.map((r) => r.id),
  );
  const suggestions = await suggestSplits(
    db,
    user,
    rows.map((r) => ({ ...r, hasSplits: splits.has(r.id) })),
  );
  const captured = await loadCaptures(
    db,
    userId,
    rows.filter((r) => r.source === "sms").map((r) => r.id),
  );

  const items = rows.map(({ splitSuggestionDismissedAt: _d, ...r }): TransactionItem => {
    const s = splits.get(r.id) ?? [];
    const suggestion = suggestions.get(r.id) ?? null;
    return {
      ...r,
      capture: captured.get(r.id) ?? null,
      splits: s,
      myShareMinor: myShareMinor(r, s),
      suggestedParticipantIds: suggestion?.participantIds ?? [],
      suggestion,
    };
  });
  return { items, total };
}

export async function getTransaction(db: Db, user: CurrentUser, id: number): Promise<TransactionItem> {
  const item = (await listTransactions(db, user, { id, limit: 1 })).items[0];
  if (!item) throw new LedgerError("not_found", "transaction_not_found", `Transaction #${id} does not exist`, { id });
  return item;
}

/** Months that have transactions, newest first. */
export async function listMonths(db: Db, user: CurrentUser): Promise<MonthCount[]> {
  const month = sql<string>`substr(${transactions.occurredOn}, 1, 7)`;
  return await db
    .select({ month, count: count() })
    .from(transactions)
    .where(eq(transactions.userId, user.id))
    .groupBy(month)
    .orderBy(desc(month));
}

export interface SpendingRow {
  id: number;
  occurredAt: string;
  occurredOn: string;
  amountMinor: number;
  currency: string;
  kind: TransactionKind;
  status: "ok" | "closed";
  duplicateOfId: number | null;
  merchant: string;
  categoryId: number | null;
  accountId: number | null;
  source: TransactionItem["source"];
  provisional: TransactionItem["provisional"];
  /** When the row was written (ISO instant): what arrived on a day, whatever its occurred_on. */
  createdAt: string;
  splits: SplitItem[];
  myShareMinor: number;
}

/** What a period's total of one currency rests on that no statement has confirmed yet. */
export interface ProvisionalTotals {
  /** Provisional captures counted in the total: rows and my share of them. */
  provisional: { count: number; minor: number };
  /** Card holds not counted: rows and their amount (positive = money held). */
  holds: { count: number; minor: number };
}

/** The provisional part of `rows` in `currency` (rows outside the spending rule ignored, holds by their amount). */
export function provisionalTotals(rows: readonly SpendingRow[], currency: string): ProvisionalTotals {
  const out: ProvisionalTotals = { provisional: { count: 0, minor: 0 }, holds: { count: 0, minor: 0 } };
  for (const r of rows) {
    if (r.currency !== currency || r.provisional == null) continue;
    if (r.provisional === "hold") {
      if (!countsAsSpending({ ...r, provisional: null })) continue;
      out.holds.count += 1;
      out.holds.minor -= r.amountMinor;
    } else if (countsAsSpending(r)) {
      out.provisional.count += 1;
      out.provisional.minor += r.myShareMinor;
    }
  }
  return out;
}

/** All rows of a month with their splits and my share. */
export async function loadMonthRows(db: Db, userId: number, month: string): Promise<SpendingRow[]> {
  if (!isMonth(month)) throw new LedgerError("invalid", "invalid_month", `Invalid month: ${month}`, { value: month });
  const { start, end } = monthRange(month);
  return await loadRowsBetween(db, userId, start, end);
}

/** All rows from `from` through `to` (inclusive dates), with their splits and my share. */
export async function loadRangeRows(db: Db, userId: number, from: string, to: string): Promise<SpendingRow[]> {
  if (!isDate(from) || !isDate(to)) throw new LedgerError("invalid", "invalid_range", `Invalid date range: ${from} ~ ${to}`, { from, to });
  return await loadRowsBetween(db, userId, from, addDays(to, 1));
}

/** Rows with start ≤ occurred_on < end (days in the user's time zone). */
async function loadRowsBetween(db: Db, userId: number, start: string, end: string): Promise<SpendingRow[]> {
  const rows = await db
    .select({
      id: transactions.id,
      occurredAt: transactions.occurredAt,
      occurredOn: transactions.occurredOn,
      amountMinor: transactions.amountMinor,
      currency: transactions.currency,
      kind: transactions.kind,
      status: transactions.status,
      duplicateOfId: transactions.duplicateOfId,
      merchant: transactions.merchant,
      categoryId: transactions.categoryId,
      accountId: transactions.accountId,
      source: transactions.source,
      provisional: transactions.provisional,
      createdAt: transactions.createdAt,
    })
    .from(transactions)
    .where(and(eq(transactions.userId, userId), gte(transactions.occurredOn, start), lt(transactions.occurredOn, end)))
    .orderBy(desc(transactions.occurredOn), desc(transactions.occurredAt), desc(transactions.id));
  const splits = await loadSplits(
    db,
    userId,
    rows.map((r) => r.id),
  );
  return rows.map((r) => {
    const s = splits.get(r.id) ?? [];
    return { ...r, splits: s, myShareMinor: myShareMinor(r, s) };
  });
}

export function spendingByCurrency(rows: readonly SpendingRow[]): CurrencyTotal[] {
  const map = new Map<string, Omit<CurrencyTotal, keyof ProvisionalTotals>>();
  for (const r of rows) {
    if (!countsAsSpending(r)) continue;
    const t = map.get(r.currency) ?? { currency: r.currency, count: 0, spendingMinor: 0 };
    t.count += 1;
    t.spendingMinor += r.myShareMinor;
    map.set(r.currency, t);
  }
  return [...map.values()].sort((a, b) => a.currency.localeCompare(b.currency)).map((t) => ({ ...t, ...provisionalTotals(rows, t.currency) }));
}

/** Spending per currency for the list header (same rule as the month view). */
export async function monthTotalsForList(db: Db, user: CurrentUser, month: string): Promise<CurrencyTotal[]> {
  return spendingByCurrency(await loadMonthRows(db, user.id, month));
}

/** Spending per currency for the list header over a date range (same rule as the stats page). */
export async function rangeTotalsForList(db: Db, user: CurrentUser, from: string, to: string): Promise<CurrencyTotal[]> {
  return spendingByCurrency(await loadRangeRows(db, user.id, from, to));
}
