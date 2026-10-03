import { counterpartyIgnores, type IdentityKind, participantIdentities, participants, transactions } from "@yomi/db";
import { zelleCounterparty } from "@yomi/importers";
import { and, eq, inArray, isNull, ne } from "@yomi/db/orm";
import type { CurrentUser } from "../user";
import {
  addIdentity,
  cleanIdentity,
  type Identity,
  type IdentityInput,
  normalizeIdentity,
  TEXT_MATCH_KINDS,
} from "./identities";
import { getTimeZone } from "../settings/time-zone";
import { dayNumber } from "../time/day";
import { localDate, todayIn } from "../time/zone";
import { type Q, SplitError } from "./internal";
import { createParticipant } from "./participants";

/** WeChat 交易类型 / Alipay 交易分类 values that mean a person-to-person transfer. */
export const P2P_CATEGORY = /转账|红包|二维码收款|收款/;
/** US person-to-person apps as they show up in bank text (Plaid name / merchant, BoA description). */
export const US_P2P_TEXT = /\bZELLE\b|\bVENMO\b|CASH\s?APP|SQUARE\s?CASH/i;
export const P2P_SOURCES = ["wechat", "alipay", "boa_csv", "plaid"] as const;

/** Words that are the app or the bank, not the person, in Plaid text. */
const APP_WORDS = /\b(venmo|zelle|cash\s?app|square\s?cash|payment|transfer|from|to|inst|xfer|web|id|ppd|conf#?)\b|[#*:]|\d+/gi;

export interface P2PRowData {
  source: string;
  sourceCategory: string | null;
  counterparty: string;
  description: string;
  /** The transaction's jsonb raw row (the export's own columns). */
  raw?: unknown;
}

/** The other person as a typed identity, or null when the row is not person-to-person or names nobody. */
export interface Party {
  kind: IdentityKind;
  value: string;
  /** Alipay 对方账号 (masked phone or email) when the export has it. */
  account: string | null;
}

function rawField(raw: unknown, name: string): string | null {
  if (!raw || typeof raw !== "object") return null;
  const v: unknown = (raw as Record<string, unknown>)[name];
  const s = typeof v === "string" ? v.trim() : "";
  return s && s !== "/" ? s : null;
}

const blank = (s: string) => {
  const t = s.trim();
  return t === "" || t === "/" ? "" : t;
};

/** Person-to-person? WeChat/Alipay by their own category, BoA by its Zelle tag, Plaid by *_FROM_APPS / *_APPS or the text. */
export function isP2P(r: P2PRowData): boolean {
  if (r.source === "wechat" || r.source === "alipay") return P2P_CATEGORY.test(r.sourceCategory ?? "");
  if (r.source === "boa_csv") return r.sourceCategory === "Zelle";
  if (r.source === "plaid") return /_APPS$/.test(r.sourceCategory ?? "") || US_P2P_TEXT.test(`${r.counterparty} ${r.description}`);
  return false;
}

/**
 * Who the transfer was with, as (kind, value). WeChat → wechat nickname; Alipay → alipay name (plus
 * 对方账号); BoA CSV Zelle → zelle_name; Plaid → the Zelle name parsed from the text, or for Venmo /
 * Cash App whatever is left after removing the app words (often nothing: then null).
 */
export function p2pParty(r: P2PRowData): Party | null {
  if (!isP2P(r)) return null;
  if (r.source === "wechat") {
    const v = blank(r.counterparty);
    return v ? { kind: "wechat", value: v, account: null } : null;
  }
  if (r.source === "alipay") {
    const account = rawField(r.raw, "对方账号");
    const v = blank(r.counterparty) || account || "";
    return v ? { kind: "alipay", value: v, account } : null;
  }
  if (r.source === "boa_csv") {
    const v = blank(r.counterparty);
    return v ? { kind: "zelle_name", value: v, account: null } : null;
  }
  const zelle = zelleCounterparty(r.description) ?? zelleCounterparty(r.counterparty);
  if (zelle?.name) return { kind: "zelle_name", value: zelle.name, account: null };
  const text = `${r.counterparty} ${r.description}`;
  const kind: IdentityKind | null = /\bVENMO\b/i.test(text) ? "venmo" : /CASH\s?APP|SQUARE\s?CASH/i.test(text) ? "other" : null;
  if (!kind) return null;
  const rest = r.counterparty.replace(APP_WORDS, " ").replace(/\s+/g, " ").trim();
  return /\p{L}.*\p{L}/u.test(rest) ? { kind, value: rest, account: null } : null;
}

/** Display name for a candidate: the parsed party when there is one, else the counterparty text. */
export function partyName(r: P2PRowData): string {
  return p2pParty(r)?.value ?? r.counterparty;
}

// ---------- matching ----------

export type MatchKind = "alias_exact" | "alias_contains";

interface Person {
  id: number;
  name: string;
  identities: Pick<Identity, "kind" | "normalized">[];
}

/**
 * Which participant a transfer belongs to. In order: an identity with the same (kind, normalized);
 * an alipay identity equal to 对方账号; then, over names and wechat / alipay / zelle_name values
 * regardless of kind, equality ("alias_exact") and finally a two-way contains of at least 2 chars
 * ("alias_contains"). Bank text is upper case and nicknames get emoji appended, hence the fallback.
 */
export function makeMatcher(people: readonly Person[]): (r: P2PRowData) => { id: number; match: MatchKind } | null {
  const byKey = new Map<string, number>();
  for (const p of people) for (const i of p.identities) byKey.set(`${i.kind}|${i.normalized}`, p.id);
  const texts = people.map((p) => ({
    id: p.id,
    keys: [
      normalizeIdentity("other", p.name),
      ...p.identities.filter((i) => TEXT_MATCH_KINDS.includes(i.kind)).map((i) => i.normalized),
    ].filter(Boolean),
  }));
  return (r) => {
    const party = p2pParty(r);
    if (party) {
      const hit = byKey.get(`${party.kind}|${normalizeIdentity(party.kind, party.value)}`);
      if (hit !== undefined) return { id: hit, match: "alias_exact" };
      if (party.account) {
        const acc = byKey.get(`alipay|${normalizeIdentity("alipay", party.account)}`);
        if (acc !== undefined) return { id: acc, match: "alias_exact" };
      }
    }
    const c = normalizeIdentity("other", party?.value ?? r.counterparty);
    if (!c) return null;
    for (const p of texts) if (p.keys.includes(c)) return { id: p.id, match: "alias_exact" };
    for (const p of texts) {
      if (p.keys.some((k) => k.length >= 2 && (c.includes(k) || k.includes(c)))) return { id: p.id, match: "alias_contains" };
    }
    return null;
  };
}

/** Non-self participants with their identities; archived ones only when asked. */
export async function peopleForMatching(db: Q, user: CurrentUser, opts: { includeArchived?: boolean } = {}): Promise<Person[]> {
  const ps = (await db
    .select({ id: participants.id, name: participants.name, archivedAt: participants.archivedAt })
    .from(participants)
    .where(and(eq(participants.userId, user.id), eq(participants.isSelf, false)))
    )
    .filter((p) => opts.includeArchived || p.archivedAt === null);
  const ids = await db
    .select({ participantId: participantIdentities.participantId, kind: participantIdentities.kind, normalized: participantIdentities.normalized })
    .from(participantIdentities)
    .where(eq(participantIdentities.userId, user.id));
  return ps.map((p) => ({ id: p.id, name: p.name, identities: ids.filter((i) => i.participantId === p.id) }));
}

// ---------- discovery ----------

export interface CounterpartyTotal {
  currency: string;
  /** Sum of incoming amounts (positive). */
  inMinor: number;
  /** Sum of outgoing amounts, as a positive magnitude. */
  outMinor: number;
}

export interface UnclaimedCounterparty {
  kind: IdentityKind;
  /** As last seen in the ledger. */
  value: string;
  normalized: string;
  inCount: number;
  outCount: number;
  totals: CounterpartyTotal[];
  firstAt: string;
  lastAt: string;
  /** Direction of the most recent transfer. */
  lastDirection: "in" | "out";
  sources: string[];
  /** Alipay 对方账号 seen with this name, if any. */
  account: string | null;
  /** A participant whose name or text identity already equals this value: claiming just confirms it. */
  suggestedParticipantId: number | null;
}

/**
 * Person-to-person counterparties in the ledger (WeChat 转账 / 红包 / 二维码收款, Alipay 转账 / 收款,
 * BoA CSV Zelle, Plaid Zelle / Venmo / Cash App) that are neither bound to a participant identity of
 * the same kind nor ignored, grouped by (kind, normalized value). Sorted by count weighted by recency
 * (a month-old group counts half).
 */
export async function listUnclaimedCounterparties(db: Q, user: CurrentUser, opts: { today?: string } = {}): Promise<UnclaimedCounterparty[]> {
  const timeZone = await getTimeZone(db, user);
  const today = dayNumber(opts.today ?? todayIn(timeZone));
  const bound = new Set(
    (await db
      .select({ kind: participantIdentities.kind, normalized: participantIdentities.normalized })
      .from(participantIdentities)
      .where(eq(participantIdentities.userId, user.id))
      )
      .map((i) => `${i.kind}|${i.normalized}`),
  );
  const ignored = new Set(
    (await db
      .select({ kind: counterpartyIgnores.kind, normalized: counterpartyIgnores.normalized })
      .from(counterpartyIgnores)
      .where(eq(counterpartyIgnores.userId, user.id))
      )
      .map((i) => `${i.kind}|${i.normalized}`),
  );
  const match = makeMatcher(await peopleForMatching(db, user));

  const groups = new Map<string, UnclaimedCounterparty & { totalsBy: Map<string, CounterpartyTotal> }>();
  for (const r of (await p2pRows(db, user))) {
    const party = p2pParty(r);
    if (!party) continue;
    const normalized = normalizeIdentity(party.kind, party.value);
    const key = `${party.kind}|${normalized}`;
    if (!normalized || bound.has(key) || ignored.has(key)) continue;
    if (party.account && bound.has(`alipay|${normalizeIdentity("alipay", party.account)}`)) continue;
    const dir = r.amountMinor > 0 ? "in" : "out";
    let g = groups.get(key);
    if (!g) {
      const m = match(r);
      g = {
        kind: party.kind,
        value: party.value,
        normalized,
        inCount: 0,
        outCount: 0,
        totals: [],
        totalsBy: new Map(),
        firstAt: r.occurredAt,
        lastAt: r.occurredAt,
        lastDirection: dir,
        sources: [],
        account: party.account,
        suggestedParticipantId: m?.match === "alias_exact" ? m.id : null,
      };
      groups.set(key, g);
    }
    if (dir === "in") g.inCount += 1;
    else g.outCount += 1;
    const t = g.totalsBy.get(r.currency) ?? { currency: r.currency, inMinor: 0, outMinor: 0 };
    if (dir === "in") t.inMinor += r.amountMinor;
    else t.outMinor += -r.amountMinor;
    g.totalsBy.set(r.currency, t);
    if (r.occurredAt < g.firstAt) g.firstAt = r.occurredAt;
    if (r.occurredAt >= g.lastAt) {
      g.lastAt = r.occurredAt;
      g.lastDirection = dir;
      g.value = party.value;
    }
    if (!g.sources.includes(r.source)) g.sources.push(r.source);
    if (!g.account && party.account) g.account = party.account;
  }

  const score = (g: UnclaimedCounterparty) => {
    const age = Math.max(0, today - dayNumber(localDate(g.lastAt, timeZone)));
    return (g.inCount + g.outCount) / (1 + age / 30);
  };
  return [...groups.values()]
    .map(({ totalsBy, ...g }) => ({ ...g, totals: [...totalsBy.values()].sort((a, b) => a.currency.localeCompare(b.currency)) }))
    .sort((a, b) => score(b) - score(a) || (a.lastAt < b.lastAt ? 1 : a.lastAt > b.lastAt ? -1 : 0) || a.normalized.localeCompare(b.normalized));
}

/** Open, non-duplicate, non-zero rows from the P2P sources, filtered to person-to-person ones. */
async function p2pRows(db: Q, user: CurrentUser) {
  return (await db
    .select({
      id: transactions.id,
      occurredAt: transactions.occurredAt,
      source: transactions.source,
      sourceCategory: transactions.sourceCategory,
      counterparty: transactions.counterpartyRaw,
      description: transactions.descriptionRaw,
      raw: transactions.raw,
      amountMinor: transactions.amountMinor,
      currency: transactions.currency,
    })
    .from(transactions)
    .where(
      and(
        eq(transactions.userId, user.id),
        inArray(transactions.source, [...P2P_SOURCES]),
        ne(transactions.amountMinor, 0),
        eq(transactions.status, "ok"),
        isNull(transactions.duplicateOfId),
      ),
    )
    )
    .filter(isP2P);
}

// ---------- claim / ignore ----------

export interface ClaimInput extends IdentityInput {
  participantId?: number;
  /** Creates this participant first, when nobody existing fits. */
  newParticipantName?: string;
}

/**
 * "That's X" / "New person": binds the counterparty to a participant as a claimed identity. Settlement
 * candidates pick up its transfers (past and future) at once, since they match on identities.
 */
export async function claimCounterparty(db: Q, user: CurrentUser, input: ClaimInput): Promise<{ identity: Identity; participantId: number }> {
  cleanIdentity(input);
  const hasId = input.participantId !== undefined;
  const hasName = (input.newParticipantName ?? "").trim() !== "";
  if (hasId === hasName) throw new SplitError("invalid", "counterparty_claim_target", "Pick a participant or type a new name");
  return await db.transaction(async (q) => {
    const pid = hasId ? input.participantId! : (await createParticipant(q, user, input.newParticipantName!)).id;
    const identity = await addIdentity(q, user, pid, { kind: input.kind, value: input.value }, "claimed");
    return { identity, participantId: pid };
  });
}

/**
 * Remembers who a settled transfer was with (used by markAsSettlement). Silent when the row is not
 * person-to-person, names nobody, or the identity already exists (for this or another participant).
 */
export async function learnIdentityFromRow(db: Q, user: CurrentUser, participantId: number, r: P2PRowData): Promise<void> {
  const party = p2pParty(r);
  if (!party) return;
  const normalized = normalizeIdentity(party.kind, party.value);
  if (!normalized) return;
  const existing = (await db
    .select({ id: participantIdentities.id })
    .from(participantIdentities)
    .where(
      and(
        eq(participantIdentities.userId, user.id),
        eq(participantIdentities.kind, party.kind),
        eq(participantIdentities.normalized, normalized),
      ),
    )
    .limit(1))[0];
  if (existing) return;
  await addIdentity(db, user, participantId, { kind: party.kind, value: party.value }, "claimed");
}
