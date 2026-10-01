import { categories, merchantRules, participants, transactions, transactionSplits } from "@yomi/db";
import { and, count, desc, eq, gte, inArray, isNull } from "@yomi/db/orm";
import type { CurrentUser } from "../user";
import { addDays, getSelf, getTransaction, nowIso, parseIdList, type Q, SplitError, todayLocal } from "./internal";
import { applySplit } from "./splits";

/** Category learning looks at split rows this many days back from today. */
export const CATEGORY_WINDOW_DAYS = 180;
/** At least this many split expense rows in the category inside the window. */
export const CATEGORY_MIN_ROWS = 5;
/** The most common participant set must cover at least this share of them. */
export const CATEGORY_MIN_SHARE = 0.8;
/**
 * And splitting must be usual for the category: split rows are at least this share of its expense rows in the window.
 * Without it, a handful of shared dinners would put a suggestion on every coffee in Dining.
 */
export const CATEGORY_MIN_SPLIT_RATE = 1 / 3;

export type SuggestionSource = "merchant" | "category" | "none";

/**
 * Why a split is suggested, as a stable code plus params for the UI to translate (participant names come from ids):
 * - `suggest_merchant_recent` {merchant, count}: the merchant's last `count` splits were all with these people.
 * - `suggest_merchant_before` {merchant}: the merchant's rule remembers these people (no matching split on record).
 * - `suggest_category_share` {category, percent, count}: `percent`% of the `count` recent split rows in the category.
 */
export interface SuggestionReason {
  code: "suggest_merchant_recent" | "suggest_merchant_before" | "suggest_category_share";
  params: Record<string, string | number>;
}

export interface SplitSuggestion {
  /** Non-self participants to split with equally; empty when source is "none". */
  participantIds: number[];
  source: SuggestionSource;
  /** 0..1: share of the relevant history that used this set (1 for a remembered merchant with no history). */
  confidence: number;
  reason: SuggestionReason | null;
}

export const NO_SUGGESTION: SplitSuggestion = { participantIds: [], source: "none", confidence: 0, reason: null };

/** What the engine needs to know about a row. */
export interface SuggestTarget {
  id: number;
  kind: string;
  status: string;
  duplicateOfId: number | null;
  merchant: string;
  categoryId: number | null;
  /** The row already has splits. */
  hasSplits: boolean;
  splitSuggestionDismissedAt: string | null;
}

interface MerchantInfo {
  ids: number[];
  suggest: boolean;
}

interface CategoryInfo {
  name: string;
  ids: number[];
  count: number;
  total: number;
}

export interface SuggestContext {
  rules: Map<string, MerchantInfo>;
  /** Split participant sets per merchant, newest first (rows I paid). */
  history: Map<string, string[]>;
  /** Learned set per category id (only categories that pass the thresholds). */
  learned: Map<number, CategoryInfo>;
}

const setKey = (ids: readonly number[]) => [...new Set(ids)].sort((a, b) => a - b).join(",");

/**
 * Participant set of each split expense row, newest first. Callers skip `friendPaid` rows: they record only me and
 * the payer, so they say nothing about who shares a kind of bill.
 */
async function splitSets(db: Q, user: CurrentUser, where: ReturnType<typeof and>) {
  const rows = await db
    .select({
      transactionId: transactionSplits.transactionId,
      participantId: transactionSplits.participantId,
      isSelf: participants.isSelf,
      paidMinor: transactionSplits.paidMinor,
      merchant: transactions.merchant,
      categoryId: transactions.categoryId,
      occurredOn: transactions.occurredOn,
      occurredAt: transactions.occurredAt,
    })
    .from(transactionSplits)
    .innerJoin(transactions, eq(transactions.id, transactionSplits.transactionId))
    .innerJoin(participants, eq(participants.id, transactionSplits.participantId))
    .where(
      and(
        eq(transactionSplits.userId, user.id),
        eq(transactions.kind, "expense"),
        eq(transactions.status, "ok"),
        isNull(transactions.duplicateOfId),
        where,
      ),
    )
    .orderBy(desc(transactions.occurredOn), desc(transactions.occurredAt), desc(transactions.id));
  const out = new Map<number, { merchant: string; categoryId: number | null; ids: number[]; friendPaid: boolean }>();
  for (const r of rows) {
    let e = out.get(r.transactionId);
    if (!e) {
      e = { merchant: r.merchant, categoryId: r.categoryId, ids: [], friendPaid: false };
      out.set(r.transactionId, e);
    }
    if (r.isSelf) continue;
    if (r.paidMinor !== 0) e.friendPaid = true;
    e.ids.push(r.participantId);
  }
  return [...out.values()].filter((e) => e.ids.length > 0);
}

/**
 * Loads what `suggestFor` needs for rows of these merchants and categories: merchant rules, the merchants' split
 * history, and the learned set of each category over the last CATEGORY_WINDOW_DAYS days.
 */
export async function suggestionContext(
  db: Q,
  user: CurrentUser,
  scope: { merchants: readonly string[]; categoryIds: readonly number[] },
  opts: { today?: string } = {},
): Promise<SuggestContext> {
  const active = new Set(
    (await db
      .select({ id: participants.id })
      .from(participants)
      .where(and(eq(participants.userId, user.id), eq(participants.isSelf, false), isNull(participants.archivedAt)))
      )
      .map((p) => p.id),
  );
  const allActive = (ids: readonly number[]) => ids.length > 0 && ids.every((id) => active.has(id));

  const merchants = [...new Set(scope.merchants.filter(Boolean))];
  const rules = new Map<string, MerchantInfo>();
  const history = new Map<string, string[]>();
  for (let i = 0; i < merchants.length; i += 500) {
    const part = merchants.slice(i, i + 500);
    for (const r of (await db
      .select({ merchant: merchantRules.merchant, participantIds: merchantRules.participantIds, suggest: merchantRules.suggest })
      .from(merchantRules)
      .where(and(eq(merchantRules.userId, user.id), inArray(merchantRules.merchant, part)))
      )) {
      rules.set(r.merchant, { ids: parseIdList(r.participantIds).filter((id) => active.has(id)), suggest: r.suggest });
    }
    for (const s of (await splitSets(db, user, inArray(transactions.merchant, part)))) {
      if (s.friendPaid) continue;
      history.set(s.merchant, [...(history.get(s.merchant) ?? []), setKey(s.ids)]);
    }
  }

  const learned = new Map<number, CategoryInfo>();
  const categoryIds = [...new Set(scope.categoryIds)];
  if (categoryIds.length) {
    const since = addDays(opts.today ?? todayLocal(), -CATEGORY_WINDOW_DAYS);
    const inWindow = and(inArray(transactions.categoryId, categoryIds), gte(transactions.occurredOn, since));
    const rowCount = new Map(
      (await db
        .select({ categoryId: transactions.categoryId, n: count() })
        .from(transactions)
        .where(
          and(
            eq(transactions.userId, user.id),
            eq(transactions.kind, "expense"),
            eq(transactions.status, "ok"),
            isNull(transactions.duplicateOfId),
            inWindow,
          ),
        )
        .groupBy(transactions.categoryId)
        )
        .map((r) => [r.categoryId, r.n]),
    );
    const tally = new Map<number, Map<string, number>>();
    for (const s of (await splitSets(db, user, inWindow))) {
      if (s.categoryId === null) continue;
      if (s.friendPaid) {
        // Not a row I paid: it is neither evidence nor part of the base.
        rowCount.set(s.categoryId, (rowCount.get(s.categoryId) ?? 0) - 1);
        continue;
      }
      const m = tally.get(s.categoryId) ?? new Map<string, number>();
      const k = setKey(s.ids);
      m.set(k, (m.get(k) ?? 0) + 1);
      tally.set(s.categoryId, m);
    }
    const names = new Map(
      (await db
        .select({ id: categories.id, name: categories.name })
        .from(categories)
        .where(and(eq(categories.userId, user.id), inArray(categories.id, [...tally.keys()])))
        )
        .map((c) => [c.id, c.name]),
    );
    for (const [categoryId, sets] of tally) {
      const total = [...sets.values()].reduce((a, b) => a + b, 0);
      const [key, top] = [...sets].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]!;
      const ids = key.split(",").map(Number);
      const base = rowCount.get(categoryId) ?? total;
      if (total < CATEGORY_MIN_ROWS || top < CATEGORY_MIN_SHARE * total || total < CATEGORY_MIN_SPLIT_RATE * base || !allActive(ids)) continue;
      learned.set(categoryId, { name: names.get(categoryId) ?? "", ids, count: top, total });
    }
  }
  return { rules, history, learned };
}

/** Merchant rule first; else the category's learned set; never for split, dismissed, closed or non-expense rows. */
export function suggestFor(ctx: SuggestContext, t: SuggestTarget): SplitSuggestion {
  if (!isCandidate(t)) return NO_SUGGESTION;
  const rule = t.merchant ? ctx.rules.get(t.merchant) : undefined;
  if (rule && !rule.suggest) return NO_SUGGESTION;
  if (rule && rule.ids.length > 0) {
    const key = setKey(rule.ids);
    const past = ctx.history.get(t.merchant) ?? [];
    let recent = 0;
    while (recent < past.length && past[recent] === key) recent++;
    const same = past.filter((k) => k === key).length;
    return {
      participantIds: rule.ids,
      source: "merchant",
      confidence: past.length ? same / past.length : 1,
      reason:
        recent > 0
          ? { code: "suggest_merchant_recent", params: { merchant: t.merchant, count: recent } }
          : { code: "suggest_merchant_before", params: { merchant: t.merchant } },
    };
  }
  const cat = t.categoryId === null ? undefined : ctx.learned.get(t.categoryId);
  if (!cat) return NO_SUGGESTION;
  return {
    participantIds: cat.ids,
    source: "category",
    confidence: cat.count / cat.total,
    reason: {
      code: "suggest_category_share",
      // Floor, so a share just under the threshold never reads as the threshold.
      params: { category: cat.name, percent: Math.floor((cat.count * 100) / cat.total), count: cat.total },
    },
  };
}

/** Suggestions for many rows with one context (list pages). */
export async function suggestSplits(db: Q, user: CurrentUser, rows: readonly SuggestTarget[], opts: { today?: string } = {}): Promise<Map<number, SplitSuggestion>> {
  const out = new Map<number, SplitSuggestion>();
  const open = rows.filter(isCandidate);
  if (open.length === 0) return out;
  const ctx = await suggestionContext(
    db,
    user,
    {
      merchants: open.map((r) => r.merchant),
      categoryIds: open.map((r) => r.categoryId).filter((id): id is number => id !== null),
    },
    opts,
  );
  for (const r of open) {
    const s = suggestFor(ctx, r);
    if (s.source !== "none") out.set(r.id, s);
  }
  return out;
}

function isCandidate(t: SuggestTarget): boolean {
  return t.kind === "expense" && t.status === "ok" && t.duplicateOfId === null && !t.hasSplits && !t.splitSuggestionDismissedAt;
}

async function targetOf(db: Q, user: CurrentUser, txId: number): Promise<SuggestTarget> {
  const t = await getTransaction(db, user, txId);
  const split = (await db
    .select({ id: transactionSplits.id })
    .from(transactionSplits)
    .where(and(eq(transactionSplits.userId, user.id), eq(transactionSplits.transactionId, txId)))
    .limit(1))[0];
  return {
    id: t.id,
    kind: t.kind,
    status: t.status,
    duplicateOfId: t.duplicateOfId,
    merchant: t.merchant,
    categoryId: t.categoryId,
    hasSplits: split !== undefined,
    splitSuggestionDismissedAt: t.splitSuggestionDismissedAt,
  };
}

/** The split suggestion for one transaction (see suggestFor). */
export async function suggestSplit(db: Q, user: CurrentUser, txId: number, opts: { today?: string } = {}): Promise<SplitSuggestion> {
  return (await suggestSplits(db, user, [await targetOf(db, user, txId)], opts)).get(txId) ?? NO_SUGGESTION;
}

export interface AcceptSuggestionsResult {
  /** Rows split now, with the people they were split with. */
  accepted: { transactionId: number; participantIds: number[] }[];
  /** Rows left alone: no suggestion any more, or core refused the split. */
  skipped: { transactionId: number; code: string; reason: string }[];
}

/**
 * "Accept all suggestions": equal split with me + each row's suggested people, recomputed here (the client's copy
 * may be stale). A user action, so rows are marked edited; merchant rules are not rewritten, so undo is a plain clear.
 */
export async function acceptSuggestions(db: Q, user: CurrentUser, txIds: readonly number[], opts: { today?: string } = {}): Promise<AcceptSuggestionsResult> {
  return await db.transaction(async (q) => {
    const ids = [...new Set(txIds)];
    const targets: SuggestTarget[] = [];
    const out: AcceptSuggestionsResult = { accepted: [], skipped: [] };
    for (const id of ids) {
      try {
        targets.push(await targetOf(q, user, id));
      } catch (e) {
        if (!(e instanceof SplitError)) throw e;
        out.skipped.push({ transactionId: id, code: e.code, reason: e.message });
      }
    }
    const suggestions = await suggestSplits(q, user, targets, opts);
    for (const t of targets) {
      const s = suggestions.get(t.id);
      if (!s) {
        out.skipped.push({ transactionId: t.id, code: "no_split_suggestion", reason: "The row has no split suggestion" });
        continue;
      }
      try {
        await applySplit(q, user, t.id, { participantIds: s.participantIds, mode: "equal" }, { markEdited: true, rememberMerchant: false });
        out.accepted.push({ transactionId: t.id, participantIds: s.participantIds });
      } catch (e) {
        if (!(e instanceof SplitError)) throw e;
        out.skipped.push({ transactionId: t.id, code: e.code, reason: e.message });
      }
    }
    return out;
  });
}

/** Undo of acceptSuggestions: clears the splits of these rows (I paid them, so nothing else is lost). */
export async function revertAcceptedSuggestions(db: Q, user: CurrentUser, txIds: readonly number[]): Promise<{ reverted: number[] }> {
  return await db.transaction(async (q) => {
    const self = await getSelf(q, user);
    const reverted: number[] = [];
    for (const id of new Set(txIds)) {
      const t = await getTransaction(q, user, id);
      if ((await hasOtherPayer(q, user, t.id, self.id))) continue;
      await applySplit(q, user, t.id, { participantIds: [], mode: "equal" }, { markEdited: true, rememberMerchant: false });
      reverted.push(t.id);
    }
    return { reverted };
  });
}

async function hasOtherPayer(db: Q, user: CurrentUser, txId: number, selfId: number): Promise<boolean> {
  return (await db
    .select({ participantId: transactionSplits.participantId, paidMinor: transactionSplits.paidMinor })
    .from(transactionSplits)
    .where(and(eq(transactionSplits.userId, user.id), eq(transactionSplits.transactionId, txId)))
    )
    .some((r) => r.participantId !== selfId && r.paidMinor !== 0);
}

/** "Not this one": hide (or bring back) the row's split suggestion. */
export async function dismissSplitSuggestion(db: Q, user: CurrentUser, txId: number, dismissed: boolean): Promise<{ transactionId: number; dismissed: boolean }> {
  const t = await getTransaction(db, user, txId);
  await db.update(transactions)
    .set({ splitSuggestionDismissedAt: dismissed ? nowIso() : null })
    .where(and(eq(transactions.userId, user.id), eq(transactions.id, t.id)));
  return { transactionId: t.id, dismissed };
}

export interface MerchantSuggestResult {
  merchant: string;
  suggest: boolean;
  /** The remembered people before this call (sorted ids), so an undo can put them back. */
  previousParticipantIds: number[];
}

/**
 * "Don't suggest for this merchant": a negative merchant rule (suggest false, remembered people cleared). An auto-split
 * rule keeps its people, since auto-split at import reads them. `suggest: true` lifts it and, when given, restores
 * `participantIds`.
 */
export async function setMerchantSuggest(
  db: Q,
  user: CurrentUser,
  merchant: string,
  input: { suggest: boolean; participantIds?: number[] },
): Promise<MerchantSuggestResult> {
  const name = merchant.trim();
  if (!name) throw new SplitError("invalid", "merchant_rule_no_merchant", "A transaction without a merchant cannot get a merchant rule");
  return await db.transaction(async (q) => {
    const current = (await q
      .select({ participantIds: merchantRules.participantIds, autoSplit: merchantRules.autoSplit })
      .from(merchantRules)
      .where(and(eq(merchantRules.userId, user.id), eq(merchantRules.merchant, name)))
      .limit(1))[0];
    const previous = parseIdList(current?.participantIds).sort((a, b) => a - b);
    let participantIds: number[] | null | undefined;
    if (!input.suggest) participantIds = current?.autoSplit ? undefined : null;
    else if (input.participantIds?.length) participantIds = [...new Set(input.participantIds)].sort((a, b) => a - b);
    const set = participantIds === undefined ? { suggest: input.suggest } : { suggest: input.suggest, participantIds };
    await q.insert(merchantRules)
      .values({ userId: user.id, merchant: name, suggest: input.suggest, participantIds: participantIds ?? null })
      .onConflictDoUpdate({ target: [merchantRules.userId, merchantRules.merchant], set });
    return { merchant: name, suggest: input.suggest, previousParticipantIds: previous };
  });
}
