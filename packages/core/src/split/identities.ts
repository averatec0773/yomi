import { counterpartyIgnores, IDENTITY_KINDS, type IdentityKind, participantIdentities, type Db } from "@yomi/db";
import { and, asc, eq } from "@yomi/db/orm";
import type { CurrentUser } from "../user";
import { getParticipant, SplitError } from "./internal";

export { IDENTITY_KINDS, type IdentityKind };

export interface Identity {
  id: number;
  participantId: number;
  kind: IdentityKind;
  value: string;
  normalized: string;
  source: "manual" | "claimed";
  createdAt: string;
}

export interface IdentityInput {
  kind: IdentityKind;
  value: string;
}

/** Kinds whose value can appear inside free bank or wallet text, so a contains-match is meaningful. */
export const TEXT_MATCH_KINDS: readonly IdentityKind[] = ["wechat", "zelle_name", "alipay"];

/**
 * Matching form of an identity value: trimmed, whitespace runs collapsed to one space, lower case.
 * Phones keep digits only; emails lose all whitespace.
 */
export function normalizeIdentity(kind: IdentityKind, value: string): string {
  if (kind === "zelle_phone") return value.replace(/\D/g, "");
  if (kind === "zelle_email") return value.replace(/\s+/g, "").toLowerCase();
  return value.trim().replace(/\s+/g, " ").toLowerCase();
}

function assertKind(kind: string): IdentityKind {
  if (!(IDENTITY_KINDS as readonly string[]).includes(kind)) throw new SplitError("invalid", "identity_kind_unknown", `Unknown identity kind: ${kind}`, { kind });
  return kind as IdentityKind;
}

/** Validated (kind, trimmed value, normalized); throws on empty or malformed input. */
export function cleanIdentity(input: IdentityInput): { kind: IdentityKind; value: string; normalized: string } {
  const kind = assertKind(input.kind);
  const value = input.value.trim().replace(/\s+/g, " ");
  if (!value) throw new SplitError("invalid", "identity_empty", "The identity cannot be empty");
  if (value.length > 120) throw new SplitError("invalid", "identity_too_long", "The identity is too long", { max: 120 });
  const normalized = normalizeIdentity(kind, value);
  if (!normalized) throw kind === "zelle_phone"
      ? new SplitError("invalid", "identity_phone_no_digits", "The phone number has no digits")
      : new SplitError("invalid", "identity_empty", "The identity cannot be empty");
  if (kind === "zelle_email" && !/^[^@\s]+@[^@\s]+$/.test(normalized)) throw new SplitError("invalid", "identity_email_invalid", "The email address is not valid");
  return { kind, value, normalized };
}

type IdentityRow = typeof participantIdentities.$inferSelect;

function toIdentity(r: IdentityRow): Identity {
  return {
    id: r.id,
    participantId: r.participantId,
    kind: r.kind,
    value: r.value,
    normalized: r.normalized,
    source: r.source,
    createdAt: r.createdAt,
  };
}

/** All identities of the user (or of one participant), oldest first. */
export async function listIdentities(db: Db, user: CurrentUser, participantId?: number): Promise<Identity[]> {
  return (await db
    .select()
    .from(participantIdentities)
    .where(
      and(
        eq(participantIdentities.userId, user.id),
        ...(participantId === undefined ? [] : [eq(participantIdentities.participantId, participantId)]),
      ),
    )
    .orderBy(asc(participantIdentities.id))
    )
    .map(toIdentity);
}

export async function findIdentity(db: Db, user: CurrentUser, kind: IdentityKind, normalized: string): Promise<Identity | null> {
  const r = (await db
    .select()
    .from(participantIdentities)
    .where(
      and(
        eq(participantIdentities.userId, user.id),
        eq(participantIdentities.kind, kind),
        eq(participantIdentities.normalized, normalized),
      ),
    )
    .limit(1))[0];
  return r ? toIdentity(r) : null;
}

/**
 * Binds (kind, value) to a participant. Idempotent for the same participant; a value already bound to
 * someone else is a conflict. Removes a matching "ignored" entry, since the user now says who it is.
 */
export async function addIdentity(
  db: Db,
  user: CurrentUser,
  participantId: number,
  input: IdentityInput,
  source: Identity["source"] = "manual",
): Promise<Identity> {
  const p = await getParticipant(db, user, participantId);
  if (p.isSelf) throw new SplitError("invalid", "identity_self", "\"Me\" needs no identities");
  const { kind, value, normalized } = cleanIdentity(input);
  const existing = await findIdentity(db, user, kind, normalized);
  if (existing) {
    if (existing.participantId === participantId) return existing;
    const owner = await getParticipant(db, user, existing.participantId);
    throw new SplitError("conflict", "identity_taken", `"${existing.value}" already belongs to ${owner.name}`, {
      value: existing.value,
      name: owner.name,
    });
  }
  const row = (await db
    .insert(participantIdentities)
    .values({ userId: user.id, participantId, kind, value, normalized, source })
    .returning()
    )[0]!;
  await db.delete(counterpartyIgnores)
    .where(and(eq(counterpartyIgnores.userId, user.id), eq(counterpartyIgnores.kind, kind), eq(counterpartyIgnores.normalized, normalized)));
  return toIdentity(row);
}

export async function removeIdentity(db: Db, user: CurrentUser, id: number): Promise<void> {
  const r = (await db
    .select({ id: participantIdentities.id })
    .from(participantIdentities)
    .where(and(eq(participantIdentities.userId, user.id), eq(participantIdentities.id, id)))
    .limit(1))[0];
  if (!r) throw new SplitError("not_found", "identity_not_found", "Identity not found");
  await db.delete(participantIdentities).where(eq(participantIdentities.id, id));
}

/** Hides a counterparty from "Who sends you money". Idempotent. */
export async function ignoreCounterparty(db: Db, user: CurrentUser, input: IdentityInput): Promise<void> {
  const { kind, normalized } = cleanIdentity(input);
  await db.insert(counterpartyIgnores).values({ userId: user.id, kind, normalized }).onConflictDoNothing();
}
