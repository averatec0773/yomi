import { categories, merchantRules, participants, transactions } from "@yomi/db";
import { and, asc, count, eq, inArray, isNull } from "@yomi/db/orm";
import { unsplitConditions } from "../ledger/unsplit";
import type { CurrentUser } from "../user";
import { getSelf, parseIdList, type Q, SplitError } from "./internal";
import { applySplit } from "./splits";

export interface MerchantRuleView {
  merchant: string;
  categoryId: number | null;
  categoryName: string | null;
  /** Remembered non-self participants (active ones only), in id order. */
  participants: { id: number; name: string }[];
  autoSplit: boolean;
  /** Rows of this merchant (any kind/status). */
  rowCount: number;
  /** Rows applyAutoSplitToExisting would split now (see ledger/unsplit.ts). */
  unsplitCount: number;
}

export interface SetAutoSplitInput {
  participantIds: number[];
  enabled: boolean;
}

/** Active non-self participants among `ids`, in the given order; unknown or archived ids are dropped. */
async function activeOthers(db: Q, user: CurrentUser, ids: readonly number[]): Promise<{ id: number; name: string }[]> {
  if (ids.length === 0) return [];
  const rows = await db
    .select({ id: participants.id, name: participants.name })
    .from(participants)
    .where(
      and(
        eq(participants.userId, user.id),
        eq(participants.isSelf, false),
        isNull(participants.archivedAt),
        inArray(participants.id, [...ids]),
      ),
    );
  const byId = new Map(rows.map((r) => [r.id, r]));
  return [...new Set(ids)].map((id) => byId.get(id)).filter((p): p is { id: number; name: string } => p !== undefined);
}

async function countRows(db: Q, user: CurrentUser, merchant: string) {
  const rowCount =
    (await db
      .select({ n: count() })
      .from(transactions)
      .where(and(eq(transactions.userId, user.id), eq(transactions.merchant, merchant)))
      .limit(1))[0]?.n ?? 0;
  const unsplitCount =
    (await db
      .select({ n: count() })
      .from(transactions)
      .where(and(...unsplitConditions(db, user.id), eq(transactions.merchant, merchant)))
      .limit(1))[0]?.n ?? 0;
  return { rowCount, unsplitCount };
}

/**
 * Merchant rules that carry split information (remembered participants or auto-split), merchant order.
 * `autoSplitOnly` narrows to the rules that split new imports on their own.
 */
export async function listMerchantRules(db: Q, user: CurrentUser, opts: { autoSplitOnly?: boolean } = {}): Promise<MerchantRuleView[]> {
  const rows = await db
    .select({
      merchant: merchantRules.merchant,
      categoryId: merchantRules.categoryId,
      categoryName: categories.name,
      participantIds: merchantRules.participantIds,
      autoSplit: merchantRules.autoSplit,
    })
    .from(merchantRules)
    .leftJoin(categories, eq(categories.id, merchantRules.categoryId))
    .where(and(eq(merchantRules.userId, user.id), opts.autoSplitOnly ? eq(merchantRules.autoSplit, true) : undefined))
    .orderBy(asc(merchantRules.merchant));
  const out: MerchantRuleView[] = [];
  for (const r of rows) {
    out.push({
      merchant: r.merchant,
      categoryId: r.categoryId,
      categoryName: r.categoryName,
      participants: await activeOthers(db, user, parseIdList(r.participantIds)),
      autoSplit: r.autoSplit,
      ...(await countRows(db, user, r.merchant)),
    });
  }
  return out;
}

export async function getMerchantRule(db: Q, user: CurrentUser, merchant: string): Promise<MerchantRuleView | null> {
  return (await listMerchantRules(db, user)).find((r) => r.merchant === merchant) ?? null;
}

/**
 * "Split {merchant} like this from now on" (equal): upserts the rule's participants and auto_split flag. Enabling needs
 * at least one active participant. Disabling keeps the participants (they stay a chip suggestion).
 */
export async function setAutoSplit(db: Q, user: CurrentUser, merchant: string, input: SetAutoSplitInput): Promise<MerchantRuleView> {
  const name = merchant.trim();
  if (!name) throw new SplitError("invalid", "auto_split_no_merchant", "A transaction without a merchant cannot get an auto-split rule");
  return await db.transaction(async (q) => {
    const self = await getSelf(q, user);
    const wanted = input.participantIds.filter((id) => id !== self.id);
    const people = await activeOthers(q, user, wanted);
    if (people.length !== new Set(wanted).size) throw new SplitError("not_found", "participant_not_found_or_archived", "A participant does not exist or is archived");
    if (input.enabled && people.length === 0) throw new SplitError("invalid", "auto_split_needs_participant", "Auto-split needs at least one person");
    const ids = people.map((p) => p.id).sort((a, b) => a - b);
    const participantIds = ids.length ? ids : null;
    // Disabling with no ids given leaves the remembered participants as they are.
    const set = participantIds ? { participantIds, autoSplit: input.enabled } : { autoSplit: input.enabled };
    await q.insert(merchantRules)
      .values({ userId: user.id, merchant: name, participantIds, autoSplit: input.enabled })
      .onConflictDoUpdate({ target: [merchantRules.userId, merchantRules.merchant], set });
    return (await getMerchantRule(q, user, name))!;
  });
}

/** Active auto-split rules as merchant → participant ids (import pipeline). */
export async function autoSplitParticipants(db: Q, user: CurrentUser): Promise<Map<string, number[]>> {
  const out = new Map<string, number[]>();
  for (const r of (await db
    .select({ merchant: merchantRules.merchant, participantIds: merchantRules.participantIds })
    .from(merchantRules)
    .where(and(eq(merchantRules.userId, user.id), eq(merchantRules.autoSplit, true)))
    )) {
    const ids = (await activeOthers(db, user, parseIdList(r.participantIds))).map((p) => p.id);
    if (ids.length) out.set(r.merchant, ids);
  }
  return out;
}

export interface ApplyAutoSplitResult {
  merchant: string;
  /** Rows split now. */
  split: number;
}

/**
 * "Split the existing N too": equal-splits every unsplit row of the merchant (ledger/unsplit.ts) with me + the
 * auto-split rule's participants (the rule must be on). Rows that already have splits are left alone. This is a user action, so the
 * rows are marked edited like a chip tap.
 */
export async function applyAutoSplitToExisting(db: Q, user: CurrentUser, merchant: string): Promise<ApplyAutoSplitResult> {
  return await db.transaction(async (q) => {
    const rule = (await q
      .select({ participantIds: merchantRules.participantIds, autoSplit: merchantRules.autoSplit })
      .from(merchantRules)
      .where(and(eq(merchantRules.userId, user.id), eq(merchantRules.merchant, merchant)))
      .limit(1))[0];
    const ids = rule?.autoSplit ? (await activeOthers(q, user, parseIdList(rule.participantIds))).map((p) => p.id) : [];
    if (ids.length === 0) throw new SplitError("invalid", "auto_split_not_enabled", `Auto-split is not on for "${merchant}"`, { merchant });
    const rows = await q
      .select({ id: transactions.id })
      .from(transactions)
      .where(and(...unsplitConditions(q, user.id), eq(transactions.merchant, merchant)));
    for (const r of rows) await applySplit(q, user, r.id, { participantIds: ids, mode: "equal" }, { markEdited: true, rememberMerchant: false });
    return { merchant, split: rows.length };
  });
}
