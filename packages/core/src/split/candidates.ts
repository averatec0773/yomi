import { settlements, transactions, type Db } from "@yomi/db";
import { and, desc, eq, inArray, isNull, ne, or } from "@yomi/db/orm";
import { convertFromRate, normalizeRate } from "../money";
import { userToday } from "../settings/time-zone";
import { addDays, dayNumber } from "../time/day";
import type { CurrentUser } from "../user";
import { balances } from "./balances";
import { isP2P, learnIdentityFromRow, makeMatcher, P2P_SOURCES, partyName, peopleForMatching } from "./counterparties";
import {
  assertCurrency,
  getParticipant,
  getTransaction,
  SplitError,
} from "./internal";
import { recordSettlement, type Settlement } from "./settlements";

const UNKNOWN_WINDOW_DAYS = 90;
const COVERED_WINDOW_DAYS = 3;

export interface CandidateBalance {
  currency: string;
  owedToMeMinor: number;
}

export interface SettlementCandidate {
  transactionId: number;
  occurredAt: string;
  source: string;
  sourceCategory: string | null;
  counterparty: string;
  amountMinor: number;
  currency: string;
  match: "alias_exact" | "alias_contains" | "none";
  suggestedParticipantId: number | null;
  /** What the settlement would record: the transfer itself, or, when the participant only owes in
   * another currency, the transfer converted at the last rate seen in that participant's settlements
   * ("received ¥X against $Y"); null when no rate is known, so the user types it. Never the whole balance. */
  suggestedAmountMinor: number | null;
  suggestedCurrency: string;
  balances: CandidateBalance[];
  /** An unlinked settlement for the suggested participant with the same amount within ±3 days:
   * the repayment may already have been recorded by hand. */
  possiblyCovered: { settlementId: number; amountMinor: number; currency: string; settledOn: string } | null;
}

/**
 * Incoming person-to-person transfers (WeChat/Alipay, BoA CSV Zelle, Plaid Zelle/Venmo/Cash App) not
 * yet linked to a settlement. Rows whose counterparty matches a participant identity (or name, see makeMatcher) come
 * first; unmatched ones from the last 90 days follow as "unknown sender" candidates. Outgoing US P2P
 * transfers (BoA / Plaid) to a matched participant are candidates too, with a negative amount ("I pay them back").
 */
export async function settlementCandidates(db: Db, user: CurrentUser, opts: { today?: string } = {}): Promise<SettlementCandidate[]> {
  const today = opts.today ?? (await userToday(db, user));
  const since = addDays(today, -UNKNOWN_WINDOW_DAYS);
  const matchParticipant = makeMatcher(await peopleForMatching(db, user));
  const rows = (await db
    .select({
      id: transactions.id,
      occurredAt: transactions.occurredAt,
      occurredOn: transactions.occurredOn,
      source: transactions.source,
      sourceCategory: transactions.sourceCategory,
      counterparty: transactions.counterpartyRaw,
      description: transactions.descriptionRaw,
      raw: transactions.raw,
      kind: transactions.kind,
      amountMinor: transactions.amountMinor,
      currency: transactions.currency,
    })
    .from(transactions)
    .leftJoin(settlements, eq(settlements.transactionId, transactions.id))
    .where(
      and(
        eq(transactions.userId, user.id),
        inArray(transactions.source, [...P2P_SOURCES]),
        or(eq(transactions.kind, "income"), eq(transactions.kind, "expense")),
        ne(transactions.amountMinor, 0),
        eq(transactions.status, "ok"),
        isNull(transactions.duplicateOfId),
        isNull(settlements.id),
      ),
    )
    .orderBy(desc(transactions.occurredAt))
    )
    .filter((r) => {
      const incoming = r.kind === "income" && r.amountMinor > 0;
      const outgoing = r.kind === "expense" && r.amountMinor < 0 && (r.source === "boa_csv" || r.source === "plaid");
      return (incoming || outgoing) && isP2P(r);
    })
    .map((r) => ({ ...r, match: matchParticipant(r), counterparty: partyName(r) }));

  const bal = await balances(db, user);
  const balancesOf = (pid: number): CandidateBalance[] =>
    bal.filter((b) => b.participantId === pid).map((b) => ({ currency: b.currency, owedToMeMinor: b.owedToMeMinor }));

  const allSettlements = await db.select().from(settlements).where(eq(settlements.userId, user.id));
  const coveredBy = (pid: number, amountMinor: number, currency: string, occurredOn: string) => {
    const day = dayNumber(occurredOn);
    const hit = allSettlements.find(
      (s) =>
        s.participantId === pid &&
        s.transactionId === null &&
        s.kind === "payment" &&
        s.amountMinor > 0 &&
        Math.abs(dayNumber(s.settledOn) - day) <= COVERED_WINDOW_DAYS &&
        ((s.amountMinor === amountMinor && s.currency === currency) ||
          (s.originalAmountMinor !== null && Math.abs(s.originalAmountMinor) === amountMinor && s.originalCurrency === currency)),
    );
    return hit ? { settlementId: hit.id, amountMinor: hit.amountMinor, currency: hit.currency, settledOn: hit.settledOn } : null;
  };
  /** Units of `to` per unit of `from`, from the participant's latest settlement that converted between them. */
  const lastRate = (pid: number, to: string, from: string): number | null => {
    const s = allSettlements
      .filter((x) => x.participantId === pid && x.currency === to && x.originalCurrency === from && x.originalAmountMinor && x.amountMinor)
      .sort((a, b) => (a.settledOn < b.settledOn ? 1 : a.settledOn > b.settledOn ? -1 : b.id - a.id))[0];
    return s ? Math.abs(s.amountMinor) / Math.abs(s.originalAmountMinor!) : null;
  };

  const matched: SettlementCandidate[] = [];
  const unknown: SettlementCandidate[] = [];
  for (const r of rows) {
    const m = r.match;
    if (!m && r.amountMinor < 0) continue;
    if (!m) {
      if (r.occurredOn < since) continue;
      unknown.push({
        transactionId: r.id,
        occurredAt: r.occurredAt,
        source: r.source,
        sourceCategory: r.sourceCategory,
        counterparty: r.counterparty,
        amountMinor: r.amountMinor,
        currency: r.currency,
        match: "none",
        suggestedParticipantId: null,
        suggestedAmountMinor: r.amountMinor,
        suggestedCurrency: r.currency,
        balances: [],
        possiblyCovered: null,
      });
      continue;
    }
    const bs = balancesOf(m.id);
    const same = bs.find((b) => b.currency === r.currency);
    const other = bs.find((b) => b.currency !== r.currency && b.owedToMeMinor > 0);
    const useOther = r.amountMinor > 0 && (!same || same.owedToMeMinor <= 0) && other !== undefined;
    const rate = useOther ? lastRate(m.id, other.currency, r.currency) : null;
    matched.push({
      transactionId: r.id,
      occurredAt: r.occurredAt,
      source: r.source,
      sourceCategory: r.sourceCategory,
      counterparty: r.counterparty,
      amountMinor: r.amountMinor,
      currency: r.currency,
      match: m.match,
      suggestedParticipantId: m.id,
      suggestedAmountMinor: useOther ? (rate === null ? null : Math.round(r.amountMinor * rate)) : r.amountMinor,
      suggestedCurrency: useOther ? other.currency : r.currency,
      balances: bs,
      possiblyCovered: r.amountMinor > 0 ? coveredBy(m.id, r.amountMinor, r.currency, r.occurredOn) : null,
    });
  }
  return [...matched, ...unknown];
}

export interface MarkAsSettlementInput {
  participantId: number;
  /** Magnitude in `currency`; the sign follows the transaction (incoming +, outgoing -). */
  amountMinor?: number;
  /** Defaults to the transaction's currency. A different one stores the transfer as the original amount. */
  currency?: string;
  /**
   * When `currency` differs: units of the transaction's currency per 1 unit of `currency`. Without amountMinor the
   * credited amount is the transfer ÷ rate (rounded once); without a rate it is derived from the two amounts.
   */
  fxRate?: string | null;
  note?: string | null;
  /** Open split items with this person (in `currency`) the transfer pays; see recordSettlement. */
  itemTransactionIds?: number[];
}

/**
 * Turns a transfer into a settlement: creates it linked to the transaction (recordSettlement flips
 * an income/expense row to kind transfer and remembers the old kind) and learns the counterparty as
 * a claimed identity (person-to-person rows only, never taking one from another participant). Only open, non-duplicate income/expense/transfer rows qualify.
 */
export async function markAsSettlement(db: Db, user: CurrentUser, txId: number, input: MarkAsSettlementInput): Promise<Settlement> {
  return await db.transaction(async (q) => {
    const t = await getTransaction(q, user, txId);
    if (t.amountMinor === 0) throw new SplitError("invalid", "settlement_zero_amount", "A zero-amount transaction cannot be marked as a settlement");
    const p = await getParticipant(q, user, input.participantId);
    if (p.isSelf) throw new SplitError("invalid", "settlement_with_self", "Cannot settle with \"me\"");

    const sign = t.amountMinor > 0 ? 1 : -1;
    const currency = input.currency ? assertCurrency(input.currency) : t.currency;
    const differs = currency !== t.currency;
    const rate = differs && input.fxRate ? normalizeRate(input.fxRate) : null;
    if (differs && input.fxRate && rate === null) {
      throw new SplitError("invalid", "settlement_fx_rate_invalid", "The rate must be a positive decimal number", { value: input.fxRate });
    }
    if (differs && input.amountMinor === undefined && rate === null) {
      throw new SplitError("invalid", "settlement_fx_amount_required", "A settlement in another currency needs the amount it counts for");
    }
    const magnitude =
      input.amountMinor !== undefined
        ? Math.abs(input.amountMinor)
        : differs
          ? convertFromRate(Math.abs(t.amountMinor), t.currency, rate!, currency)
          : Math.abs(t.amountMinor);
    if (magnitude === 0) throw new SplitError("invalid", "settlement_amount_invalid", "The settlement amount must be a non-zero integer (minor units)");

    const s = await recordSettlement(q, user, {
      participantId: p.id,
      amountMinor: sign * magnitude,
      currency,
      originalAmountMinor: differs ? t.amountMinor : null,
      originalCurrency: differs ? t.currency : null,
      fxRate: rate,
      settledOn: t.occurredOn,
      note: input.note ?? null,
      transactionId: t.id,
      itemTransactionIds: input.itemTransactionIds ?? null,
    });
    await learnIdentityFromRow(q, user, p.id, {
      source: t.source,
      sourceCategory: t.sourceCategory,
      counterparty: t.counterpartyRaw,
      description: t.descriptionRaw,
      raw: t.raw,
    });
    return s;
  });
}
