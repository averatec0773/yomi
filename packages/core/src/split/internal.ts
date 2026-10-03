import { participants, transactions, type Db } from "@yomi/db";
import { CodedError, type ErrorKind, type MessageParams } from "@yomi/importers";
import { and, eq } from "@yomi/db/orm";
import { clockNow } from "../time/clock";
import type { CurrentUser } from "../user";

/** Db or a transaction handle: both are Drizzle Postgres databases. */
export type Q = Db;

export class SplitError extends CodedError {
  constructor(kind: ErrorKind, code: string, message: string, params: MessageParams = {}) {
    super(kind, code, message, params);
    this.name = "SplitError";
  }
}

export type ParticipantRow = typeof participants.$inferSelect;
export type TransactionRow = typeof transactions.$inferSelect;

export function nowIso(): string {
  return new Date().toISOString();
}

/** The integer ids of a jsonb id list (merchant_rules.participant_ids); anything else reads as empty. */
export function parseIdList(v: unknown): number[] {
  return Array.isArray(v) ? v.filter((x): x is number => Number.isInteger(x)) : [];
}

export async function getSelf(db: Q, user: CurrentUser): Promise<ParticipantRow> {
  const self = (await db
    .select()
    .from(participants)
    .where(and(eq(participants.userId, user.id), eq(participants.isSelf, true)))
    .limit(1))[0];
  if (!self) throw new SplitError("invalid", "self_participant_missing", "The \"me\" participant is missing; run the seed first");
  return self;
}

export async function getParticipant(db: Q, user: CurrentUser, id: number): Promise<ParticipantRow> {
  const p = (await db
    .select()
    .from(participants)
    .where(and(eq(participants.userId, user.id), eq(participants.id, id)))
    .limit(1))[0];
  if (!p) throw new SplitError("not_found", "participant_not_found", `Participant ${id} does not exist`, { ids: String(id) });
  return p;
}

export async function getTransaction(db: Q, user: CurrentUser, id: number): Promise<TransactionRow> {
  const t = (await db
    .select()
    .from(transactions)
    .where(and(eq(transactions.userId, user.id), eq(transactions.id, id)))
    .limit(1))[0];
  if (!t) throw new SplitError("not_found", "transaction_not_found", `Transaction ${id} does not exist`, { id });
  return t;
}

export function assertCurrency(c: string): string {
  const code = c.trim().toUpperCase();
  if (!/^[A-Z]{3}$/.test(code)) throw new SplitError("invalid", "invalid_currency", `Invalid currency ${JSON.stringify(c)}`, { value: String(c) });
  return code;
}

export function assertDate(d: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) throw new SplitError("invalid", "invalid_date", `Dates must be YYYY-MM-DD, got ${JSON.stringify(d)}`, { value: String(d) });
  return d;
}

/** 'YYYY-MM-DD' → noon local time in the ledger's +08:00 convention; full ISO strings pass through. */
export function toOccurredAt(dateOrIso: string): string {
  if (/^\d{4}-\d{2}-\d{2}$/.test(dateOrIso)) return `${dateOrIso}T12:00:00+08:00`;
  if (/^\d{4}-\d{2}-\d{2}T/.test(dateOrIso)) return dateOrIso;
  throw new SplitError("invalid", "invalid_date", `Invalid date ${JSON.stringify(dateOrIso)}`, { value: String(dateOrIso) });
}

export function dayNumber(date: string): number {
  const [y, m, d] = date.slice(0, 10).split("-").map(Number);
  return Date.UTC(y ?? 0, (m ?? 1) - 1, d ?? 1) / 86_400_000;
}

export function addDays(date: string, days: number): string {
  return new Date((dayNumber(date) + days) * 86_400_000).toISOString().slice(0, 10);
}

export function todayLocal(): string {
  const d = clockNow();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
