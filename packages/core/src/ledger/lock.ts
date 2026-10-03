import { type Db, settlements, transactionSplits } from "@yomi/db";
import { and, eq } from "@yomi/db/orm";

export type LockReason = "edited" | "split" | "settled";

/**
 * Why a stored row must not be rewritten by a machine (bank sync, a statement superseding a capture): I edited it,
 * split it, or recorded a settlement on it. Null when nothing of mine is on it.
 */
export async function lockReason(q: Db, userId: number, tx: { id: number; userEditedAt: string | null }): Promise<LockReason | null> {
  if (tx.userEditedAt != null) return "edited";
  if ((await q.select({ id: transactionSplits.id }).from(transactionSplits).where(eq(transactionSplits.transactionId, tx.id)).limit(1))[0]) {
    return "split";
  }
  if (
    (await q
      .select({ id: settlements.id })
      .from(settlements)
      .where(and(eq(settlements.userId, userId), eq(settlements.transactionId, tx.id)))
      .limit(1))[0]
  ) {
    return "settled";
  }
  return null;
}

