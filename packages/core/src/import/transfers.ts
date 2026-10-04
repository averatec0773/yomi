import {
  type Db,
  investmentAccounts,
  investmentTransactions,
  type KindRule,
  participantIdentities,
  participants,
  settlements,
  transactions,
  transactionSplits,
} from "@yomi/db";
import { and, eq, inArray, isNotNull, isNull, ne, or } from "@yomi/db/orm";
import { LedgerError } from "../ledger/errors";
import { isP2P, p2pParty } from "../split/counterparties";
import { normalizeIdentity } from "../split/identities";
import { dayDiff } from "../time/day";
import type { CurrentUser } from "../user";

// Own-account transfers: money moving between two of my own accounts (checking → savings, bank → IBKR, a wire I sent
// myself) is neither income nor spending. Detection reads the ledger and proposes; applying records the rule and the
// prior kind on every leg so Undo can put them back. History is never changed by detection alone: the review queue
// shows every proposal, and only rows a new import brings in get high-confidence proposals applied automatically.

/** Days between the two legs of a pair (the link passes' window). */
const PAIR_WINDOW_DAYS = 3;
/** Days between a bank row and the brokerage's own record of the deposit or withdrawal. */
const BROKER_WINDOW_DAYS = 5;
/** How a brokerage shows up in bank text, by provider of an investment account the user has. */
const BROKER_TEXT: Record<string, RegExp> = { ibkr: /INTERACTIVE\s*BR|IBKR/i };
/** Bank text of a movement between accounts: person-to-person apps, ACH, wires, Online Banking transfers, wallet top-ups. */
const TRANSFER_TEXT = /\bZELLE\b|\bVENMO\b|CASH\s?APP|\bACH\b|\bWIRE\b|ONLINE\s+BANKING|\bTRANSFER\b|\bXFER\b|\bTRNSFR\b|\bDES:|转账|提现|充值/i;
/** BoA CSV categories (set by the importer) of a movement between accounts. */
const BOA_TRANSFER = new Set(["Zelle", "Wire", "ACH", "Transfer"]);
/** The other party of a wire in bank text: `ORIG:1/NAME ID:` (in) or `BNF:NAME ID:` (out). */
const WIRE_PARTY = /\b(?:ORIG|BNF):(?:\d\/)?(.+?)\s+ID:/i;

export type TransferConfidence = "high" | "medium";
/**
 * name: the sender or receiver is one of my names. pair: the opposite leg is in another of my accounts; pairs: more
 * than one row could be that leg. broker: the text names my brokerage; investment: the brokerage recorded the same
 * transfer. bank: the bank classifies it as a transfer between accounts.
 */
export type TransferReason = "name" | "pair" | "pairs" | "broker" | "investment" | "bank";

export interface TransferProposal {
  /** The row the proposal is about (the incoming leg of a pair). */
  transactionId: number;
  /** The other leg, in another of my accounts; null when it is not in the ledger. */
  peerId: number | null;
  rule: KindRule;
  confidence: TransferConfidence;
  reasons: TransferReason[];
}

type Leg = Awaited<ReturnType<typeof openLegs>>[number];

/**
 * Rows a transfer rule may still look at: open, final (no capture or hold), not a linked duplicate, not edited, split
 * or settled, never dismissed and not already decided by a rule.
 */
async function openLegs(q: Db, user: CurrentUser) {
  const rows = await q
    .select({
      id: transactions.id,
      accountId: transactions.accountId,
      occurredOn: transactions.occurredOn,
      amountMinor: transactions.amountMinor,
      currency: transactions.currency,
      kind: transactions.kind,
      source: transactions.source,
      sourceCategory: transactions.sourceCategory,
      counterparty: transactions.counterpartyRaw,
      description: transactions.descriptionRaw,
      merchant: transactions.merchant,
      raw: transactions.raw,
    })
    .from(transactions)
    .where(
      and(
        eq(transactions.userId, user.id),
        inArray(transactions.kind, ["income", "expense", "transfer"]),
        ne(transactions.amountMinor, 0),
        eq(transactions.status, "ok"),
        isNull(transactions.duplicateOfId),
        isNull(transactions.provisional),
        isNull(transactions.userEditedAt),
        isNull(transactions.reviewDismissedAt),
        isNull(transactions.kindRule),
        isNull(transactions.transferPeerId),
      ),
    );
  const split = await q.select({ id: transactionSplits.transactionId }).from(transactionSplits).where(eq(transactionSplits.userId, user.id));
  const settled = await q
    .select({ id: settlements.transactionId })
    .from(settlements)
    .where(and(eq(settlements.userId, user.id), isNotNull(settlements.transactionId)));
  const locked = new Set([...split.map((r) => r.id), ...settled.map((r) => r.id)]);
  return rows.filter((r) => !locked.has(r.id)).sort((a, b) => a.occurredOn.localeCompare(b.occurredOn) || a.id - b.id);
}

/** My names on transfers ("Names on my transfers": identities of the self participant), normalized. */
async function selfNames(q: Db, user: CurrentUser): Promise<Set<string>> {
  const rows = await q
    .select({ normalized: participantIdentities.normalized })
    .from(participantIdentities)
    .innerJoin(participants, eq(participants.id, participantIdentities.participantId))
    .where(and(eq(participantIdentities.userId, user.id), eq(participants.isSelf, true)));
  return new Set(rows.map((r) => r.normalized));
}

/** Who sent or received the money, as the row names them (Zelle or wallet party, wire ORIG / BNF), normalized. */
function partyNames(l: Leg): string[] {
  const out = [p2pParty(l)?.value, l.source === "boa_csv" && l.sourceCategory === "Wire" ? l.counterparty : null];
  for (const text of [l.description, l.counterparty]) out.push(WIRE_PARTY.exec(text)?.[1] ?? null);
  return out.flatMap((v) => (v ? [normalizeIdentity("other", v)] : []));
}

function transferLike(l: Leg): boolean {
  const sc = l.sourceCategory ?? "";
  if (isP2P(l) || (l.source === "boa_csv" && BOA_TRANSFER.has(sc))) return true;
  if (l.source === "plaid" && /^TRANSFER_(IN|OUT)(\/|$)/.test(sc)) return true;
  return TRANSFER_TEXT.test(`${l.counterparty} ${l.description} ${sc}`);
}

/** Plaid calls it a transfer between the user's own accounts or into investments. */
const bankSaysOwn = (l: Leg) => l.source === "plaid" && /^TRANSFER_(IN|OUT)\/.*(ACCOUNT_TRANSFER|INVESTMENT_AND_RETIREMENT_FUNDS)$/.test(l.sourceCategory ?? "");

/** A Plaid transfer (not a person-to-person app) the importer typed as transfer: nothing else says the money was mine. */
const bankHint = (l: Leg) => l.source === "plaid" && l.kind === "transfer" && /^TRANSFER_(IN|OUT)(\/|$)/.test(l.sourceCategory ?? "") && !/_FROM_APPS$/.test(l.sourceCategory ?? "");

/** Brokerage-side transfers (deposits +, withdrawals −) of the providers the user has accounts with. */
async function brokerTransfers(q: Db, user: CurrentUser) {
  return await q
    .select({
      id: investmentTransactions.id,
      provider: investmentAccounts.provider,
      date: investmentTransactions.date,
      amountMinor: investmentTransactions.amountMinor,
      currency: investmentTransactions.currency,
    })
    .from(investmentTransactions)
    .innerJoin(investmentAccounts, eq(investmentAccounts.id, investmentTransactions.investmentAccountId))
    .where(and(eq(investmentTransactions.userId, user.id), eq(investmentTransactions.type, "transfer")));
}

async function brokerProviders(q: Db, user: CurrentUser): Promise<string[]> {
  const rows = await q.selectDistinct({ provider: investmentAccounts.provider }).from(investmentAccounts).where(eq(investmentAccounts.userId, user.id));
  return rows.map((r) => r.provider).filter((p) => BROKER_TEXT[p]);
}

/**
 * Own-account transfer proposals over the ledger (read only), in order of precedence: a unique opposite pair across
 * two of my accounts (high), my own name as sender or receiver (high), a brokerage named in the text with the
 * brokerage's own record of it (high; without that record medium), a pair with several candidates (medium, nearest
 * day), a Plaid transfer with nothing else behind it (medium). `ids`: only proposals touching these rows.
 */
export async function detectOwnTransfers(q: Db, user: CurrentUser, opts: { ids?: readonly number[] } = {}): Promise<TransferProposal[]> {
  const legs = await openLegs(q, user);
  const names = await selfNames(q, user);
  const providers = await brokerProviders(q, user);
  const invRows = providers.length ? (await brokerTransfers(q, user)).filter((r) => providers.includes(r.provider)) : [];

  const byCharge = new Map<string, Leg[]>();
  for (const l of legs) {
    if (l.accountId == null || !transferLike(l)) continue;
    const k = `${l.currency}|${l.amountMinor}`;
    byCharge.set(k, [...(byCharge.get(k) ?? []), l]);
  }
  const used = new Set<number>();
  const usedInv = new Set<number>();
  const out: TransferProposal[] = [];
  const opposite = (l: Leg) =>
    (byCharge.get(`${l.currency}|${-l.amountMinor}`) ?? []).filter(
      (o) => !used.has(o.id) && o.accountId !== l.accountId && Math.abs(dayDiff(l.occurredOn, o.occurredOn)) <= PAIR_WINDOW_DAYS,
    );
  const pairable = (l: Leg) => !used.has(l.id) && l.accountId != null && transferLike(l);
  const pair = (l: Leg, peer: Leg, unique: boolean) => {
    const [main, other] = l.amountMinor > 0 ? [l, peer] : [peer, l];
    const reasons: TransferReason[] = ["pair", ...(unique ? [] : ["pairs" as const]), ...(bankSaysOwn(l) || bankSaysOwn(peer) ? ["bank" as const] : [])];
    out.push({ transactionId: main.id, peerId: other.id, rule: "pair", confidence: unique ? "high" : "medium", reasons });
    used.add(l.id);
    used.add(peer.id);
  };
  const open = (l: Leg) => l.kind !== "transfer";

  for (const l of legs) {
    if (!pairable(l)) continue;
    const c = opposite(l);
    if (c.length === 1 && opposite(c[0]!).length === 1 && (open(l) || open(c[0]!))) pair(l, c[0]!, true);
  }
  for (const l of legs) {
    if (used.has(l.id) || !open(l) || !partyNames(l).some((n) => names.has(n))) continue;
    out.push({ transactionId: l.id, peerId: null, rule: "own_name", confidence: "high", reasons: ["name"] });
    used.add(l.id);
  }
  for (const l of legs) {
    if (used.has(l.id) || !open(l)) continue;
    const text = `${l.counterparty} ${l.description} ${l.merchant}`;
    const named = providers.filter((p) => BROKER_TEXT[p]!.test(text));
    if (named.length === 0) continue;
    const inv = invRows.find(
      (r) =>
        !usedInv.has(r.id) &&
        named.includes(r.provider) &&
        r.currency === l.currency &&
        r.amountMinor === -l.amountMinor &&
        Math.abs(dayDiff(l.occurredOn, r.date)) <= BROKER_WINDOW_DAYS,
    );
    if (inv) usedInv.add(inv.id);
    out.push({ transactionId: l.id, peerId: null, rule: "broker", confidence: inv ? "high" : "medium", reasons: inv ? ["broker", "investment"] : ["broker"] });
    used.add(l.id);
  }
  for (const l of legs) {
    if (!pairable(l)) continue;
    const c = opposite(l)
      .filter((o) => open(l) || open(o))
      .sort((a, b) => Math.abs(dayDiff(l.occurredOn, a.occurredOn)) - Math.abs(dayDiff(l.occurredOn, b.occurredOn)) || a.id - b.id);
    if (c.length > 0) pair(l, c[0]!, false);
  }
  for (const l of legs) {
    if (used.has(l.id) || !bankHint(l)) continue;
    out.push({ transactionId: l.id, peerId: null, rule: "hint", confidence: "medium", reasons: ["bank"] });
  }
  if (!opts.ids) return out;
  const ids = new Set(opts.ids);
  return out.filter((p) => ids.has(p.transactionId) || (p.peerId != null && ids.has(p.peerId)));
}

/**
 * Makes the proposal's rows transfers: each leg keeps its prior kind (prior_kind) and the rule (kind_rule), and the
 * two legs of a pair point at each other. A user's confirmation also marks the rows edited, so no machine rewrites them.
 */
export async function applyOwnTransfer(
  q: Db,
  user: CurrentUser,
  p: Pick<TransferProposal, "transactionId" | "peerId" | "rule">,
  opts: { by: "user" | "auto" },
): Promise<void> {
  const ids = p.peerId == null ? [p.transactionId] : [p.transactionId, p.peerId];
  const rows = await q
    .select({ id: transactions.id, kind: transactions.kind })
    .from(transactions)
    .where(and(eq(transactions.userId, user.id), inArray(transactions.id, ids)));
  const now = new Date().toISOString();
  for (const r of rows) {
    await q
      .update(transactions)
      .set({
        kind: "transfer",
        priorKind: r.kind === "transfer" ? null : r.kind,
        kindRule: p.rule,
        transferPeerId: ids.find((id) => id !== r.id) ?? null,
        ...(opts.by === "user" ? { userEditedAt: now } : {}),
        updatedAt: now,
      })
      .where(eq(transactions.id, r.id));
  }
}

/** Applies the high-confidence proposals that touch these (newly imported) rows; returns how many rows became transfers. */
export async function applyNewTransfers(q: Db, user: CurrentUser, ids: readonly number[]): Promise<number> {
  if (ids.length === 0) return 0;
  let n = 0;
  for (const p of await detectOwnTransfers(q, user, { ids })) {
    if (p.confidence !== "high") continue;
    await applyOwnTransfer(q, user, p, { by: "auto" });
    n += p.peerId == null ? 1 : 2;
  }
  return n;
}

/**
 * Takes back the transfer a rule (or a confirmation) made of this row and its peer: prior kinds return, the rule and
 * the peer link go. `dismiss` (the user says it is not a transfer): the rows are marked edited and dismissed, so no
 * rule proposes them again; otherwise (the toast's Undo) they return to the review queue. Returns the rows changed.
 */
export async function revertOwnTransfer(q: Db, user: CurrentUser, id: number, opts: { dismiss: boolean }): Promise<number[]> {
  const row = (await q.select().from(transactions).where(and(eq(transactions.userId, user.id), eq(transactions.id, id))).limit(1))[0];
  if (!row) throw new LedgerError("not_found", "transaction_not_found", `Transaction #${id} does not exist`, { id });
  if (row.kindRule == null) throw new LedgerError("conflict", "transfer_rule_missing", `Transaction #${id} was not made a transfer by a rule`, { id });
  const legs = await q
    .select()
    .from(transactions)
    .where(and(eq(transactions.userId, user.id), or(eq(transactions.id, id), row.transferPeerId == null ? undefined : eq(transactions.id, row.transferPeerId))));
  const now = new Date().toISOString();
  for (const l of legs) {
    await q
      .update(transactions)
      .set({
        kind: l.priorKind ?? l.kind,
        priorKind: null,
        kindRule: null,
        transferPeerId: null,
        userEditedAt: opts.dismiss ? now : null,
        reviewDismissedAt: opts.dismiss ? now : l.reviewDismissedAt,
        updatedAt: now,
      })
      .where(eq(transactions.id, l.id));
  }
  return legs.map((l) => l.id);
}

/**
 * The row is no longer the transfer a rule made (its kind is being edited, or its peer is being deleted): the rule and
 * the peer link are cleared on it, and the peer leg gets its prior kind back. The row's own kind is the caller's.
 */
export async function releaseTransfer(q: Db, user: CurrentUser, ids: readonly number[]): Promise<void> {
  if (ids.length === 0) return;
  const rows = await q
    .select({ id: transactions.id, peerId: transactions.transferPeerId })
    .from(transactions)
    .where(and(eq(transactions.userId, user.id), inArray(transactions.id, [...ids]), or(isNotNull(transactions.kindRule), isNotNull(transactions.transferPeerId))));
  const peers = rows.flatMap((r) => (r.peerId != null && !ids.includes(r.peerId) ? [r.peerId] : []));
  const now = new Date().toISOString();
  if (rows.length) {
    await q
      .update(transactions)
      .set({ priorKind: null, kindRule: null, transferPeerId: null, updatedAt: now })
      .where(inArray(transactions.id, rows.map((r) => r.id)));
  }
  for (const p of peers.length ? await q.select().from(transactions).where(inArray(transactions.id, peers)) : []) {
    await q
      .update(transactions)
      .set({ kind: p.priorKind ?? p.kind, priorKind: null, kindRule: null, transferPeerId: null, updatedAt: now })
      .where(eq(transactions.id, p.id));
  }
}
