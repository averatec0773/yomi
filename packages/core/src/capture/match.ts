import { accounts, type CaptureCandidate, type CapturePayload, captures, type Db, transactions } from "@yomi/db";
import { and, eq, gte, inArray, isNull, lte, or } from "@yomi/db/orm";
import { parsePaymentMethod } from "../import/accounts";
import { splitAndSettledIds } from "../ledger/lock";
import { addDays, dayDiff } from "../time/day";
import type { CurrentUser } from "../user";
import { supersede } from "./supersede";

// Matching a capture (a pasted card SMS) to the statement row of the same charge. Strict one-to-one: a pair is linked
// only when each side has exactly one candidate; ties and near misses go to the review queue, never "closest wins".

export type MatchReason = "amount" | "card" | "merchant" | "time";

/** A provisional capture as the matcher sees it, with the day and merchant of its ledger row. */
export interface OpenCapture {
  id: number;
  transactionId: number;
  occurredAt: string;
  /** Day of the capture in the user's time zone (its row's occurred_on). */
  occurredOn: string;
  amountMinor: number;
  currency: string;
  last4: string | null;
  hold: boolean;
  merchant: string;
  /** Split, settled, edited or noted: never paired blindly with an interchangeable twin, nor with a posting SMS. */
  locked: boolean;
  /** Rows the user said are not this capture. */
  rejected: readonly number[];
  /** Captured in this run. */
  isNew: boolean;
}

/** A ledger row that can confirm a capture: a statement or wallet row, or (for a hold) the SMS of the posted charge. */
export interface AuthorityRow {
  id: number;
  source: string;
  occurredAt: string;
  occurredOn: string;
  amountMinor: number;
  currency: string;
  originalAmountMinor: number | null;
  originalCurrency: string | null;
  merchant: string;
  last4: string | null;
  /** Arrived in this run (an imported batch, a synced page). */
  isNew: boolean;
}

export interface Candidate {
  authorityId: number;
  reasons: MatchReason[];
  /** Authority day minus capture day (user's time zone). */
  daysAfter: number;
  /** Outside the amount or time tolerance by a little: only ever a review item. */
  near: boolean;
}

/** A card alert and the ICBC statement row (posted 入账日期) are −1 to +3 days apart, in the user's time zone. */
export const PDF_WINDOW = { from: -1, to: 3 } as const;
/** A hold and the alert of the posted charge: 0 to +7 days. */
const HOLD_WINDOW = { from: 0, to: 7 } as const;
/** A card alert and the Alipay / WeChat payment it paid: ±10 minutes (both carry Beijing instants). */
const WALLET_WINDOW_MS = 10 * 60 * 1000;
/** Near miss: up to this many days outside a day window. */
const NEAR_EXTRA_DAYS = 2;
const WALLETS: ReadonlySet<string> = new Set(["alipay", "wechat"]);
const AUTHORITY_SOURCES = ["icbc_pdf", "alipay", "wechat", "sms"] as const;

const CJK_RE = /[㐀-鿿豈-﫿]/;

function tokens(merchant: string): string[] {
  return merchant
    .toUpperCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((t) => (CJK_RE.test(t) ? t.length >= 2 : t.length >= 3 && !/^\d+$/.test(t)));
}

/**
 * Whether two merchant names can be the same shop: true when either is empty (nothing to compare), or they
 * share a word (3+ letters; Chinese names when one contains the other). `BUSY BEE BOBA` and `Busy Bee Boba
 * Houston` overlap; `Costco` and `Shell` do not.
 */
export function merchantsOverlap(a: string, b: string): boolean {
  const ta = tokens(a);
  const tb = tokens(b);
  if (ta.length === 0 || tb.length === 0) return true;
  return ta.some((x) => tb.some((y) => x === y || (CJK_RE.test(x) && CJK_RE.test(y) && (x.includes(y) || y.includes(x)))));
}

function sameSign(a: number, b: number): boolean {
  return Math.sign(a) === Math.sign(b);
}

/** Exact amount: the booked amount, or the original amount a foreign charge was booked from (ICBC 交易金额). */
function amountMatches(c: OpenCapture, a: AuthorityRow): boolean {
  if (a.currency === c.currency && a.amountMinor === c.amountMinor) return true;
  return a.originalCurrency === c.currency && a.originalAmountMinor === c.amountMinor;
}

/** Near amount: a hold the charge came in 0 to 30% above (tips), or an original amount within 1% (FX rounding). */
function amountNear(c: OpenCapture, a: AuthorityRow): boolean {
  if (!sameSign(a.amountMinor, c.amountMinor)) return false;
  const cap = Math.abs(c.amountMinor);
  if (c.hold && a.currency === c.currency) {
    const auth = Math.abs(a.amountMinor);
    if (auth > cap && auth * 10 <= cap * 13) return true;
  }
  if (a.originalCurrency === c.currency && a.originalAmountMinor != null && sameSign(a.originalAmountMinor, c.amountMinor)) {
    return Math.abs(Math.abs(a.originalAmountMinor) - cap) * 100 <= cap;
  }
  return false;
}

/** "in" the window, "near" it (a day-window only, up to two days outside), or null. Wallet rows compare instants. */
function timeFit(c: OpenCapture, a: AuthorityRow): { fit: "in" | "near"; daysAfter: number } | null {
  const daysAfter = dayDiff(c.occurredOn, a.occurredOn);
  if (WALLETS.has(a.source)) {
    const gap = Math.abs(Date.parse(a.occurredAt) - Date.parse(c.occurredAt));
    return Number.isFinite(gap) && gap <= WALLET_WINDOW_MS ? { fit: "in", daysAfter } : null;
  }
  const w = a.source === "sms" ? HOLD_WINDOW : PDF_WINDOW;
  if (daysAfter >= w.from && daysAfter <= w.to) return { fit: "in", daysAfter };
  if (daysAfter >= w.from - NEAR_EXTRA_DAYS && daysAfter <= w.to + NEAR_EXTRA_DAYS) return { fit: "near", daysAfter };
  return null;
}

/**
 * Whether `a` can be the statement row of capture `c`, and how well. Card: both last fours known must agree (3141 never
 * meets 5501); a wallet row must name the card. Merchant: words must overlap when both have one (a hold has none).
 * Exact candidates fit amount and time; near ones miss exactly one of them by a little.
 */
export function evaluate(c: OpenCapture, a: AuthorityRow): Candidate | null {
  // The SMS of a posted charge stands in for the statement only for a hold nothing of mine is on yet; a split hold
  // waits for the statement row, which it then takes the facts of.
  if (a.source === "sms" && (!c.hold || c.locked)) return null;
  if (c.last4 && a.last4 && c.last4 !== a.last4) return null;
  if (c.last4 && !a.last4 && WALLETS.has(a.source)) return null;
  if (!WALLETS.has(a.source) && !merchantsOverlap(c.merchant, a.merchant)) return null;
  const time = timeFit(c, a);
  if (!time) return null;
  const exactAmount = amountMatches(c, a);
  if (!exactAmount && (time.fit === "near" || !amountNear(c, a))) return null;
  const near = time.fit === "near" || !exactAmount;
  const reasons: MatchReason[] = [];
  if (exactAmount) reasons.push("amount");
  if (c.last4 && a.last4) reasons.push("card");
  if (c.merchant && a.merchant && !WALLETS.has(a.source)) reasons.push("merchant");
  if (time.fit === "in") reasons.push("time");
  return { authorityId: a.id, reasons, daysAfter: time.daysAfter, near };
}

/** Display order only (never a tie-breaker): card, merchant, then the smaller time distance. */
function byStrength(a: Candidate, b: Candidate): number {
  const score = (x: Candidate) => (x.reasons.includes("card") ? 2 : 0) + (x.reasons.includes("merchant") ? 1 : 0);
  return score(b) - score(a) || Math.abs(a.daysAfter) - Math.abs(b.daysAfter) || a.authorityId - b.authorityId;
}

export interface MatchPlan {
  /** Pairs to link now. */
  link: { captureId: number; authorityId: number }[];
  /** Every other open capture: its review (null = nothing to look at) and the candidates offered. */
  reviews: Map<number, { review: "ambiguous" | "near_miss" | null; candidates: Candidate[] }>;
}

function sameCharge(xs: readonly { amountMinor: number; currency: string; merchant: string; last4: string | null }[]): boolean {
  const key = (x: (typeof xs)[number]) => [x.amountMinor, x.currency, x.merchant.trim().toLowerCase(), x.last4 ?? ""].join("|");
  return xs.every((x) => key(x) === key(xs[0]!));
}

/**
 * The one-to-one plan over all open captures and candidate rows. A connected group of exact candidates links only
 * when it is one capture and one row, or k captures × k rows of the same card, amount, currency and merchant where no
 * capture carries anything of mine (paired in time order: the result is the same whichever way they pair). A link
 * needs something new on one side (`isNew`), so an old capture never joins an old row without the user. Everything
 * else is an `ambiguous` review with all its candidates (nothing linked); a capture with only near candidates is a
 * `near_miss`.
 */
export function planMatches(caps: readonly OpenCapture[], auths: readonly AuthorityRow[]): MatchPlan {
  const authById = new Map(auths.map((a) => [a.id, a]));
  const exact = new Map<number, Candidate[]>();
  const near = new Map<number, Candidate[]>();
  for (const c of caps) {
    const all = auths.filter((a) => !c.rejected.includes(a.id)).flatMap((a) => evaluate(c, a) ?? []);
    exact.set(c.id, all.filter((x) => !x.near).sort(byStrength));
    near.set(c.id, all.filter((x) => x.near).sort(byStrength));
  }
  const capsOf = new Map<number, number[]>();
  for (const c of caps) for (const x of exact.get(c.id)!) capsOf.set(x.authorityId, [...(capsOf.get(x.authorityId) ?? []), c.id]);

  const capById = new Map(caps.map((c) => [c.id, c]));
  const plan: MatchPlan = { link: [], reviews: new Map() };
  const seen = new Set<number>();
  const taken = new Set<number>();
  for (const start of caps) {
    if (seen.has(start.id) || exact.get(start.id)!.length === 0) continue;
    // The connected group of captures and rows reachable through exact candidates.
    const group = new Set<number>();
    const rows = new Set<number>();
    const queue = [start.id];
    while (queue.length) {
      const id = queue.pop()!;
      if (group.has(id)) continue;
      group.add(id);
      for (const x of exact.get(id)!) {
        rows.add(x.authorityId);
        for (const other of capsOf.get(x.authorityId) ?? []) if (!group.has(other)) queue.push(other);
      }
    }
    for (const id of group) seen.add(id);
    const gc = [...group].map((id) => capById.get(id)!);
    const ga = [...rows].map((id) => authById.get(id)!);
    const fresh = gc.some((c) => c.isNew) || ga.some((a) => a.isNew);
    const complete = gc.every((c) => exact.get(c.id)!.length === ga.length);
    const twins = gc.length === ga.length && complete && (gc.length === 1 || (sameCharge(gc) && sameCharge(ga) && gc.every((c) => !c.locked)));
    if (fresh && twins) {
      const byTime = <T extends { occurredAt: string; id: number }>(xs: T[]) => [...xs].sort((a, b) => Date.parse(a.occurredAt) - Date.parse(b.occurredAt) || a.id - b.id);
      const orderedAuths = byTime(ga);
      byTime(gc).forEach((c, i) => {
        plan.link.push({ captureId: c.id, authorityId: orderedAuths[i]!.id });
        taken.add(orderedAuths[i]!.id);
      });
      continue;
    }
    for (const c of gc) plan.reviews.set(c.id, { review: "ambiguous", candidates: exact.get(c.id)! });
  }
  for (const c of caps) {
    if (seen.has(c.id)) continue;
    const offered = near.get(c.id)!.filter((x) => !taken.has(x.authorityId));
    plan.reviews.set(c.id, offered.length ? { review: "near_miss", candidates: offered } : { review: null, candidates: [] });
  }
  return plan;
}

/** Open captures of the user with their row's day, merchant and lock. */
async function loadOpenCaptures(q: Db, user: CurrentUser, newIds: ReadonlySet<number>): Promise<(OpenCapture & { review: string | null; payload: CapturePayload })[]> {
  const rows = await q
    .select({
      id: captures.id,
      transactionId: captures.transactionId,
      occurredAt: captures.occurredAt,
      amountMinor: captures.amountMinor,
      currency: captures.currency,
      last4: captures.last4,
      hold: captures.hold,
      review: captures.review,
      payload: captures.payload,
      occurredOn: transactions.occurredOn,
      merchant: transactions.merchant,
      note: transactions.note,
      sharedNote: transactions.sharedNote,
      userEditedAt: transactions.userEditedAt,
    })
    .from(captures)
    .innerJoin(transactions, eq(transactions.id, captures.transactionId))
    .where(and(eq(captures.userId, user.id), eq(captures.state, "provisional")));
  const locks = await splitAndSettledIds(q, user.id, rows.map((r) => r.transactionId!));
  return rows.map((r) => ({
    id: r.id,
    transactionId: r.transactionId!,
    occurredAt: r.occurredAt,
    occurredOn: r.occurredOn,
    amountMinor: r.amountMinor,
    currency: r.currency,
    last4: r.last4,
    hold: r.hold,
    merchant: r.merchant,
    locked: r.note != null || r.sharedNote != null || r.userEditedAt != null || locks.split.has(r.transactionId!) || locks.settled.has(r.transactionId!),
    rejected: r.payload.rejected ?? [],
    isNew: newIds.has(r.id),
    review: r.review,
    payload: r.payload,
  }));
}

/**
 * Rows that may confirm one of `caps`: ok, not a duplicate, final (or, for a hold, the provisional SMS of the posted
 * charge), in the capture's currency (booked or original), near its day, and not already the statement row of another
 * capture.
 */
async function loadAuthorities(q: Db, user: CurrentUser, caps: readonly OpenCapture[], newIds: ReadonlySet<number>): Promise<AuthorityRow[]> {
  if (caps.length === 0) return [];
  // Each capture's widest window (a near miss before a statement row, after a posted hold); overlapping ones merge.
  const windows: { from: string; to: string }[] = [];
  for (const day of caps.map((c) => c.occurredOn).sort()) {
    const from = addDays(day, PDF_WINDOW.from - NEAR_EXTRA_DAYS);
    const to = addDays(day, HOLD_WINDOW.to + NEAR_EXTRA_DAYS);
    const last = windows.at(-1);
    if (last && from <= last.to) last.to = to;
    else windows.push({ from, to });
  }
  const currencies = [...new Set(caps.map((c) => c.currency))];
  const rows = await q
    .select({
      id: transactions.id,
      source: transactions.source,
      occurredAt: transactions.occurredAt,
      occurredOn: transactions.occurredOn,
      amountMinor: transactions.amountMinor,
      currency: transactions.currency,
      originalAmountMinor: transactions.originalAmountMinor,
      originalCurrency: transactions.originalCurrency,
      merchant: transactions.merchant,
      paymentMethod: transactions.paymentMethod,
      accountLast4: accounts.last4,
    })
    .from(transactions)
    .leftJoin(accounts, eq(accounts.id, transactions.accountId))
    .where(
      and(
        eq(transactions.userId, user.id),
        inArray(transactions.source, [...AUTHORITY_SOURCES]),
        eq(transactions.status, "ok"),
        isNull(transactions.duplicateOfId),
        or(isNull(transactions.provisional), and(eq(transactions.source, "sms"), eq(transactions.provisional, "capture"))),
        or(inArray(transactions.currency, currencies), inArray(transactions.originalCurrency, currencies)),
        or(...windows.map((w) => and(gte(transactions.occurredOn, w.from), lte(transactions.occurredOn, w.to)))),
      ),
    );
  const claimed = new Set(
    rows.length === 0
      ? []
      : (
          await q
            .select({ id: captures.authorityId })
            .from(captures)
            .where(and(eq(captures.userId, user.id), inArray(captures.state, ["confirmed", "superseded"]), inArray(captures.authorityId, rows.map((r) => r.id))))
        ).map((r) => r.id),
  );
  return rows
    .filter((r) => !claimed.has(r.id))
    .map((r) => ({
      id: r.id,
      source: r.source,
      occurredAt: r.occurredAt,
      occurredOn: r.occurredOn,
      amountMinor: r.amountMinor,
      currency: r.currency,
      originalAmountMinor: r.originalAmountMinor,
      originalCurrency: r.originalCurrency,
      merchant: r.merchant,
      last4: parsePaymentMethod(r.paymentMethod)?.last4 ?? r.accountLast4,
      isNew: newIds.has(r.id),
    }));
}

export interface MatchRunResult {
  /** Captures linked to their statement row in this run. */
  linked: number;
  /** Open captures with an ambiguous or near-miss review after the run. */
  toReview: number;
}

const sameCandidates = (a: readonly CaptureCandidate[], b: readonly Candidate[]) =>
  a.length === b.length && a.every((x, i) => x.id === b[i]!.authorityId && x.reasons.join() === b[i]!.reasons.join());

/**
 * Re-plans every open capture of the user and applies the plan: links (see `supersede`), then writes the reviews that
 * changed. `newCaptureIds` / `newAuthorityIds` name what arrived in this run (a pasted SMS, an imported batch); with
 * neither, nothing is linked and the run only refreshes the queue (startup, after a resolution or an undo). `by`
 * goes to the audit trail: `import:<batchId>`, `sync:<connectionId>`, `user`. All or nothing: it runs in its own
 * transaction, a savepoint when `q` is already one.
 */
export async function runMatching(
  q: Db,
  user: CurrentUser,
  opts: { by: string; newCaptureIds?: readonly number[]; newAuthorityIds?: readonly number[] },
): Promise<MatchRunResult> {
  return await q.transaction((tx) => matchOpenCaptures(tx, user, opts));
}

async function matchOpenCaptures(
  q: Db,
  user: CurrentUser,
  opts: { by: string; newCaptureIds?: readonly number[]; newAuthorityIds?: readonly number[] },
): Promise<MatchRunResult> {
  const caps = await loadOpenCaptures(q, user, new Set(opts.newCaptureIds ?? []));
  // A new alert's own row is new as an authority too (the posted charge's SMS for an earlier hold).
  const newRows = new Set([...(opts.newAuthorityIds ?? []), ...caps.filter((c) => c.isNew).map((c) => c.transactionId)]);
  const auths = await loadAuthorities(q, user, caps, newRows);
  const plan = planMatches(caps, auths);
  for (const l of plan.link) await supersede(q, user, l.captureId, l.authorityId, { by: opts.by });
  let toReview = 0;
  for (const c of caps) {
    const r = plan.reviews.get(c.id);
    if (!r) continue;
    if (r.review) toReview += 1;
    if (r.review === c.review && sameCandidates(c.payload.candidates ?? [], r.candidates)) continue;
    const { candidates: _old, ...rest } = c.payload;
    await q
      .update(captures)
      .set({
        review: r.review,
        payload: r.candidates.length ? { ...rest, candidates: r.candidates.map((x) => ({ id: x.authorityId, reasons: x.reasons })) } : rest,
      })
      .where(eq(captures.id, c.id));
  }
  return { linked: plan.link.length, toReview };
}
