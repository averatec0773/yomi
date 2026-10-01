import { transactions } from "@yomi/db";
import { eq } from "@yomi/db/orm";
import type { CurrentUser } from "../user";
import { getTransaction, nowIso, type Q, SplitError } from "./internal";

export const SHARED_NOTE_MAX = 500;

export interface SharedNote {
  transactionId: number;
  sharedNote: string | null;
}

/** The note written for the people a transaction is shared with (their statement shows it; `note` stays private). */
export async function getSharedNote(db: Q, user: CurrentUser, transactionId: number): Promise<SharedNote> {
  const t = await getTransaction(db, user, transactionId);
  return { transactionId: t.id, sharedNote: t.sharedNote };
}

/** Sets or clears (empty or null) the shared note. Counts as a user edit, so an import revert keeps the row. */
export async function setSharedNote(db: Q, user: CurrentUser, transactionId: number, note: string | null): Promise<SharedNote> {
  const t = await getTransaction(db, user, transactionId);
  const value = note?.trim() || null;
  if (value !== null && value.length > SHARED_NOTE_MAX) {
    throw new SplitError("invalid", "shared_note_too_long", `A shared note is at most ${SHARED_NOTE_MAX} characters`, { max: SHARED_NOTE_MAX });
  }
  await db.update(transactions).set({ sharedNote: value, userEditedAt: nowIso() }).where(eq(transactions.id, t.id));
  return { transactionId: t.id, sharedNote: value };
}
