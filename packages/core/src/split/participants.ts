import { participants, transactions, transactionSplits, type Db } from "@yomi/db";
import { and, eq, max, ne } from "@yomi/db/orm";
import type { CurrentUser } from "../user";
import { addIdentity, type Identity, type IdentityInput, listIdentities } from "./identities";
import { getParticipant, nowIso, type ParticipantRow, SplitError } from "./internal";

export interface Participant {
  id: number;
  name: string;
  isSelf: boolean;
  /** Typed payment-app / bank identities (participant_identities), oldest first. */
  identities: Identity[];
  archivedAt: string | null;
  lastUsedAt: string | null;
}

function toParticipant(p: ParticipantRow, lastUsedAt: string | null, identities: Identity[]): Participant {
  return { id: p.id, name: p.name, isSelf: p.isSelf, identities, archivedAt: p.archivedAt, lastUsedAt };
}

function cleanName(name: string): string {
  const n = name.trim();
  if (!n) throw new SplitError("invalid", "participant_name_empty", "The name cannot be empty");
  if (n.length > 40) throw new SplitError("invalid", "participant_name_too_long", "The name is too long", { max: 40 });
  return n;
}

async function assertNameFree(db: Db, user: CurrentUser, name: string, exceptId?: number): Promise<void> {
  const clash = (await db
    .select({ id: participants.id })
    .from(participants)
    .where(
      and(
        eq(participants.userId, user.id),
        eq(participants.name, name),
        ...(exceptId === undefined ? [] : [ne(participants.id, exceptId)]),
      ),
    )
    .limit(1))[0];
  if (clash) throw new SplitError("conflict", "participant_name_taken", `A participant named "${name}" already exists`, { name });
}

/** Self first, then by most recent split use (never-used last, by creation order). Archived hidden unless asked. */
export async function listParticipants(db: Db, user: CurrentUser, opts: { includeArchived?: boolean } = {}): Promise<Participant[]> {
  const rows = await db.select().from(participants).where(eq(participants.userId, user.id));
  const used = await db
    .select({ participantId: transactionSplits.participantId, last: max(transactions.occurredAt) })
    .from(transactionSplits)
    .innerJoin(transactions, eq(transactions.id, transactionSplits.transactionId))
    .where(eq(transactionSplits.userId, user.id))
    .groupBy(transactionSplits.participantId);
  const lastUsed = new Map(used.map((u) => [u.participantId, u.last]));
  const ids = new Map<number, Identity[]>();
  for (const i of (await listIdentities(db, user))) ids.set(i.participantId, [...(ids.get(i.participantId) ?? []), i]);
  return rows
    .filter((p) => opts.includeArchived || !p.archivedAt)
    .map((p) => toParticipant(p, lastUsed.get(p.id) ?? null, ids.get(p.id) ?? []))
    .sort((a, b) => {
      if (a.isSelf !== b.isSelf) return a.isSelf ? -1 : 1;
      const la = a.lastUsedAt ?? "";
      const lb = b.lastUsedAt ?? "";
      if (la !== lb) return la < lb ? 1 : -1;
      return a.id - b.id;
    });
}

/** Creates a participant, optionally with identities (all or nothing). */
export async function createParticipant(db: Db, user: CurrentUser, name: string, identities: readonly IdentityInput[] = []): Promise<Participant> {
  const n = cleanName(name);
  return await db.transaction(async (q) => {
    await assertNameFree(q, user, n);
    const row = (await q.insert(participants).values({ userId: user.id, name: n, isSelf: false }).returning())[0]!;
    const bound: Identity[] = [];
    for (const i of identities) bound.push(await addIdentity(q, user, row.id, i));
    return toParticipant(row, null, [...new Map(bound.map((b) => [b.id, b])).values()]);
  });
}

export async function renameParticipant(db: Db, user: CurrentUser, id: number, name: string): Promise<Participant> {
  const p = await getParticipant(db, user, id);
  if (p.isSelf) throw new SplitError("invalid", "participant_self_rename", "Cannot rename \"me\"");
  const n = cleanName(name);
  await assertNameFree(db, user, n, id);
  const row = (await db.update(participants).set({ name: n }).where(eq(participants.id, id)).returning())[0];
  return toParticipant(row!, null, await listIdentities(db, user, id));
}

/** Soft delete; history and balances keep the row. `archived: false` restores it. */
export async function archiveParticipant(db: Db, user: CurrentUser, id: number, archived = true): Promise<Participant> {
  const p = await getParticipant(db, user, id);
  if (p.isSelf) throw new SplitError("invalid", "participant_self_archive", "Cannot archive \"me\"");
  const row = (await db
    .update(participants)
    .set({ archivedAt: archived ? (p.archivedAt ?? nowIso()) : null })
    .where(eq(participants.id, id))
    .returning()
    )[0]!;
  return toParticipant(row!, null, await listIdentities(db, user, id));
}
