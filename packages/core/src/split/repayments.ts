import { type Db, participants, transactions } from "@yomi/db";
import { and, eq, inArray, isNotNull } from "@yomi/db/orm";
import { dayDiff } from "../time/day";
import type { CurrentUser } from "../user";
import { balances } from "./balances";
import { type SettlementCandidate, settlementCandidates } from "./candidates";
import { type OpenItem, openItems } from "./items";

// AA repayments: which incoming person-to-person transfers pay back what a friend owes, scored by name, amount and
// timing. Proposals go to the review queue; nothing is ever settled without the user.

/** A repayment comes at most this long after the oldest item it pays. */
const MAX_AGE_DAYS = 120;
/** Subsets of open items are searched up to this many items (2^8 sums). */
const SUBSET_LIMIT = 8;

/**
 * name: the sender is the person by identity or name. balance: the amount equals what is open with them. items: it
 * equals what is open on certain items. partial: it is less than what is open. time: it came after those items and not
 * long after. fx: compared in the currency they owe in, converted at the last rate of their settlements.
 */
export type RepaymentReason = "name" | "balance" | "items" | "partial" | "time" | "fx";

export interface RepaymentItem {
  transactionId: number;
  date: string;
  merchant: string;
  /** What is open on it (+ they owe me). */
  remainingMinor: number;
}

export interface RepaymentProposal {
  participantId: number;
  participantName: string;
  /** The items it pays (empty for a partial payment or a balance that is not only items). */
  itemTransactionIds: number[];
  items: RepaymentItem[];
  /** What the settlement records, in `currency`. */
  amountMinor: number;
  currency: string;
  /** What stays open with them in `currency` after it ("All settled" at 0). */
  balanceAfterMinor: number;
  confidence: "high" | "medium";
  reasons: RepaymentReason[];
  /** A settlement recorded by hand with the same amount within 3 days: it may already be in. */
  possiblyCovered: SettlementCandidate["possiblyCovered"];
}

export interface RepaymentMatch {
  transactionId: number;
  occurredOn: string;
  proposal: RepaymentProposal;
}

type AmountFit = { kind: "balance" | "items" | "partial"; items: OpenItem[] };

/** Exact-sum subsets of `items` (at most SUBSET_LIMIT of them), up to two: enough to tell a unique one. */
function exactSubsets(items: readonly OpenItem[], amount: number): OpenItem[][] {
  if (items.length > SUBSET_LIMIT) return [];
  const out: OpenItem[][] = [];
  for (let mask = 1; mask < 1 << items.length && out.length < 2; mask++) {
    const pick = items.filter((_, i) => mask & (1 << i));
    if (pick.reduce((s, x) => s + x.remainingMinor, 0) === amount) out.push(pick);
  }
  return out;
}

/** How `amount` relates to what is open (balance and the items they owe on, oldest first); null when it is more. */
function amountFit(amount: number, balance: number, owing: readonly OpenItem[]): AmountFit | null {
  if (balance <= 0 || amount > balance) return null;
  const sum = owing.reduce((s, x) => s + x.remainingMinor, 0);
  if (amount === balance) return { kind: "balance", items: sum === balance ? [...owing] : [] };
  let run = 0;
  for (const [i, it] of owing.entries()) {
    run += it.remainingMinor;
    if (run === amount) return { kind: "items", items: owing.slice(0, i + 1) };
    if (run > amount) break;
  }
  const singles = owing.filter((x) => x.remainingMinor === amount);
  if (singles.length === 1) return { kind: "items", items: singles };
  const subsets = exactSubsets(owing, amount);
  if (subsets.length === 1) return { kind: "items", items: subsets[0]! };
  return { kind: "partial", items: [] };
}

/** On or after the newest item it pays (the oldest open one for a partial payment), and within MAX_AGE_DAYS of the oldest. */
function timely(day: string, fit: AmountFit, owing: readonly OpenItem[]): boolean {
  const items = fit.items.length ? fit.items : owing.slice(0, 1);
  if (items.length === 0) return true;
  const dates = items.map((x) => x.date).sort();
  return day >= dates.at(-1)! && dayDiff(dates[0]!, day) <= MAX_AGE_DAYS;
}

/**
 * Repayment proposals for incoming transfers settlementCandidates lists (rows the user dismissed left out), best first.
 * high: the sender is the person (identity or exact name) and the amount is their open balance or exactly some open
 * items, on time. medium: the sender is the person and pays part; or a looser name match with balance or items; or an
 * unknown sender whose amount is exactly one person's balance or item set (that person is suggested). Everything else
 * stays a plain candidate on Split and settle.
 */
export async function repaymentProposals(db: Db, user: CurrentUser, opts: { today?: string } = {}): Promise<RepaymentMatch[]> {
  const dismissed = new Set(
    (await db
      .select({ id: transactions.id })
      .from(transactions)
      .where(and(eq(transactions.userId, user.id), isNotNull(transactions.reviewDismissedAt)))).map((r) => r.id),
  );
  const candidates = (await settlementCandidates(db, user, opts)).filter((c) => c.amountMinor > 0 && !dismissed.has(c.transactionId));
  if (candidates.length === 0) return [];
  const days = new Map(
    (await db
      .select({ id: transactions.id, occurredOn: transactions.occurredOn })
      .from(transactions)
      .where(and(eq(transactions.userId, user.id), inArray(transactions.id, candidates.map((c) => c.transactionId))))).map((r) => [r.id, r.occurredOn]),
  );
  const names = new Map(
    (await db.select({ id: participants.id, name: participants.name }).from(participants).where(eq(participants.userId, user.id))).map((p) => [p.id, p.name]),
  );
  const owingCache = new Map<string, OpenItem[]>();
  const owingOf = async (pid: number, currency: string) => {
    const k = `${pid}|${currency}`;
    if (!owingCache.has(k)) owingCache.set(k, (await openItems(db, user, pid, currency)).filter((x) => x.remainingMinor > 0));
    return owingCache.get(k)!;
  };
  // Who owes me what, for unknown senders: one balance per person and currency.
  const owed = (await balances(db, user)).filter((b) => b.owedToMeMinor > 0 && !b.archived);

  const out: RepaymentMatch[] = [];
  for (const c of candidates) {
    const day = days.get(c.transactionId)!;
    const propose = async (pid: number, amount: number, currency: string, balance: number, strength: "strong" | "weak" | "unknown") => {
      const owing = await owingOf(pid, currency);
      const fit = amountFit(amount, balance, owing);
      if (!fit || !timely(day, fit, owing)) return null;
      const exact = fit.kind !== "partial";
      const confidence = strength === "strong" && exact ? "high" : (strength === "strong" || exact) ? "medium" : null;
      if (!confidence) return null;
      const reasons: RepaymentReason[] = [...(strength === "strong" ? ["name" as const] : []), fit.kind, "time", ...(currency !== c.currency ? ["fx" as const] : [])];
      return {
        participantId: pid,
        participantName: names.get(pid) ?? "",
        itemTransactionIds: fit.items.map((x) => x.transactionId),
        items: fit.items.map((x) => ({ transactionId: x.transactionId, date: x.date, merchant: x.merchant, remainingMinor: x.remainingMinor })),
        amountMinor: amount,
        currency,
        balanceAfterMinor: balance - amount,
        confidence,
        reasons,
        possiblyCovered: c.possiblyCovered,
      } satisfies RepaymentProposal;
    };

    let proposal: RepaymentProposal | null = null;
    if (c.suggestedParticipantId != null && c.suggestedAmountMinor != null) {
      const balance = c.balances.find((b) => b.currency === c.suggestedCurrency)?.owedToMeMinor ?? 0;
      proposal = await propose(c.suggestedParticipantId, c.suggestedAmountMinor, c.suggestedCurrency, balance, c.match === "alias_exact" ? "strong" : "weak");
    } else if (c.match === "none") {
      const hits: RepaymentProposal[] = [];
      for (const o of owed) {
        if (o.currency !== c.currency) continue;
        const p = await propose(o.participantId, c.amountMinor, c.currency, o.owedToMeMinor, "unknown");
        if (p) hits.push(p);
      }
      proposal = hits.length === 1 ? hits[0]! : null;
    }
    if (proposal) out.push({ transactionId: c.transactionId, occurredOn: day, proposal });
  }
  return out.sort((a, b) => Number(a.proposal.confidence === "medium") - Number(b.proposal.confidence === "medium") || b.occurredOn.localeCompare(a.occurredOn) || b.transactionId - a.transactionId);
}
