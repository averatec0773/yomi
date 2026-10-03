import { categories, type CaptureState, type CaptureUndo, captures, type Db, transactions } from "@yomi/db";
import { CodedError, type MessageParams } from "@yomi/importers";
import { and, eq } from "@yomi/db/orm";
import { lockReason } from "../ledger/lock";
import { applySplit, getSplit } from "../split/splits";
import type { CurrentUser } from "../user";

export type CaptureErrorKind = "not_found" | "invalid";

export class CaptureError extends CodedError {
  constructor(
    readonly kind: CaptureErrorKind,
    code: string,
    message: string,
    params: MessageParams = {},
  ) {
    super(code, message, params);
    this.name = "CaptureError";
  }
}

export type CaptureRow = typeof captures.$inferSelect;
type TxRow = typeof transactions.$inferSelect;
type TxPatch = Partial<typeof transactions.$inferInsert>;

const nowIso = () => new Date().toISOString();

export async function getCapture(q: Db, user: CurrentUser, id: number): Promise<CaptureRow> {
  const c = (await q.select().from(captures).where(and(eq(captures.userId, user.id), eq(captures.id, id))).limit(1))[0];
  if (!c) throw new CaptureError("not_found", "capture_not_found", `Capture #${id} does not exist`, { id });
  return c;
}

async function txRow(q: Db, user: CurrentUser, id: number): Promise<TxRow> {
  const t = (await q.select().from(transactions).where(and(eq(transactions.userId, user.id), eq(transactions.id, id))).limit(1))[0];
  if (!t) throw new CaptureError("not_found", "transaction_not_found", `Transaction #${id} does not exist`, { id });
  return t;
}

/** The capture's own ledger row (every SMS capture has one). */
export async function captureRow(q: Db, user: CurrentUser, c: CaptureRow): Promise<TxRow> {
  return await txRow(q, user, c.transactionId!);
}

function pick(row: TxRow, keys: readonly string[]): Record<string, unknown> {
  const r = row as unknown as Record<string, unknown>;
  return Object.fromEntries(keys.map((k) => [k, r[k]]));
}

/**
 * Records a resolution on the capture: its new state and review, an Undo entry with what was there before (`row`,
 * `authority`: prior column values the caller changed) and a history line. The pasted text and the offered
 * candidates are dropped once the capture is no longer provisional.
 */
export async function recordResolution(
  q: Db,
  c: CaptureRow,
  next: { action: string; state: CaptureState; review?: CaptureRow["review"]; authorityId?: number | null; rejected?: number[]; by: string } & Pick<
    CaptureUndo,
    "row" | "authority" | "resplit"
  >,
): Promise<void> {
  const now = nowIso();
  const { candidates: _c, text, ...payload } = c.payload;
  const entry: CaptureUndo = {
    action: next.action,
    prev: { state: c.state, review: c.review, authorityId: c.authorityId, rejected: payload.rejected ?? [], ...(text !== undefined ? { text } : {}) },
    ...(next.row ? { row: next.row } : {}),
    ...(next.authority ? { authority: next.authority } : {}),
    ...(next.resplit ? { resplit: next.resplit } : {}),
  };
  const open = next.state === "provisional";
  await q
    .update(captures)
    .set({
      state: next.state,
      review: next.review ?? null,
      authorityId: next.authorityId === undefined ? c.authorityId : next.authorityId,
      resolvedAt: open ? null : now,
      payload: {
        ...payload,
        ...(open && text !== undefined ? { text } : {}),
        ...(next.rejected ? { rejected: next.rejected } : {}),
        undo: [...(payload.undo ?? []), entry],
        history: [...payload.history, { at: now, from: c.state, to: next.state, by: next.by }],
      },
    })
    .where(eq(captures.id, c.id));
}

/**
 * Links an open capture to the statement row of the same charge. Nothing of mine on the capture's row: the statement
 * row stays primary, the capture's row becomes its duplicate (`superseded`), and what the statement row lacks
 * (merchant, a category better than none or 其他, note, shared note) is copied onto it. Split, settled or edited: the
 * capture's row stays primary so splits and settlements never move, it takes the statement's facts (amount,
 * currency, original amount, time, account, kind, raw counterparty and description; the merchant only when it has
 * none) and the statement row becomes its duplicate (`confirmed`); an equal split is recomputed for a new amount, an
 * exact one gets an `amount_changed` review. Every change is undoable (undoResolution). All or nothing: it runs in its
 * own transaction, a savepoint when `q` is already one.
 */
export async function supersede(q: Db, user: CurrentUser, captureId: number, authorityId: number, opts: { by: string }): Promise<CaptureState> {
  return await q.transaction((tx) => linkCapture(tx, user, captureId, authorityId, opts));
}

async function linkCapture(q: Db, user: CurrentUser, captureId: number, authorityId: number, opts: { by: string }): Promise<CaptureState> {
  const c = await getCapture(q, user, captureId);
  if (c.state !== "provisional") throw new CaptureError("invalid", "capture_not_open", `Capture #${captureId} was already resolved`, { id: captureId });
  const row = await captureRow(q, user, c);
  const auth = await txRow(q, user, authorityId);

  if ((await lockReason(q, user.id, row)) == null) {
    const other = (await q.select({ id: categories.id }).from(categories).where(and(eq(categories.userId, user.id), eq(categories.name, "其他"))).limit(1))[0]?.id;
    const weakCategory = auth.categoryId == null || auth.categoryId === other;
    const fields: TxPatch = {
      ...(!auth.merchant && row.merchant ? { merchant: row.merchant } : {}),
      ...(weakCategory && row.categoryId != null && row.categoryId !== other ? { categoryId: row.categoryId } : {}),
      ...(auth.note == null && row.note ? { note: row.note } : {}),
      ...(auth.sharedNote == null && row.sharedNote ? { sharedNote: row.sharedNote } : {}),
    };
    if (Object.keys(fields).length) await q.update(transactions).set(fields).where(eq(transactions.id, auth.id));
    await q.update(transactions).set({ duplicateOfId: auth.id, provisional: null }).where(eq(transactions.id, row.id));
    await recordResolution(q, c, {
      action: "link",
      state: "superseded",
      authorityId: auth.id,
      by: opts.by,
      row: pick(row, ["duplicateOfId", "provisional"]),
      authority: { id: auth.id, fields: pick(auth, Object.keys(fields)) },
    });
    return "superseded";
  }

  const facts: TxPatch = {
    amountMinor: auth.amountMinor,
    currency: auth.currency,
    originalAmountMinor: auth.originalAmountMinor,
    originalCurrency: auth.originalCurrency,
    occurredAt: auth.occurredAt,
    occurredOn: auth.occurredOn,
    accountId: auth.accountId,
    kind: auth.kind,
    counterpartyRaw: auth.counterpartyRaw,
    descriptionRaw: auth.descriptionRaw,
    ...(!row.merchant && auth.merchant ? { merchant: auth.merchant } : {}),
    provisional: null,
  };
  await q.update(transactions).set({ duplicateOfId: row.id }).where(eq(transactions.id, auth.id));
  await q.update(transactions).set(facts).where(eq(transactions.id, row.id));
  let review: CaptureRow["review"] = null;
  let resplit: CaptureUndo["resplit"];
  if (Math.abs(auth.amountMinor) !== Math.abs(row.amountMinor) || auth.currency !== row.currency) {
    const split = await getSplit(q, user, row.id);
    if (split && (split.mode === "equal" || split.mode === "full")) {
      resplit = { participantIds: split.participantIds, mode: split.mode };
      await applySplit(q, user, row.id, resplit, { markEdited: false, rememberMerchant: false });
    } else if (split) {
      review = "amount_changed";
    }
  }
  await recordResolution(q, c, {
    action: "link",
    state: "confirmed",
    review,
    authorityId: auth.id,
    by: opts.by,
    row: pick(row, Object.keys(facts)),
    authority: { id: auth.id, fields: { duplicateOfId: auth.duplicateOfId } },
    ...(resplit ? { resplit } : {}),
  });
  return "confirmed";
}

/**
 * Puts a capture whose statement row is about to be deleted (its import batch reverted, the bank removed it) back to
 * provisional: its resolutions are undone down to the link. A capture linked before captures existed (backfilled,
 * nothing to undo) is reopened as it stands; the caller clears pointers into the deleted row.
 */
export async function detachFromAuthority(q: Db, user: CurrentUser, captureId: number, opts: { by: string }): Promise<void> {
  let c = await getCapture(q, user, captureId);
  const authorityId = c.authorityId;
  while (c.authorityId === authorityId && (c.state === "confirmed" || c.state === "superseded")) {
    if ((c.payload.undo ?? []).length === 0) {
      await q.update(transactions).set({ provisional: c.hold ? "hold" : "capture" }).where(eq(transactions.id, c.transactionId!));
      await q
        .update(captures)
        .set({
          state: "provisional",
          review: null,
          authorityId: null,
          resolvedAt: null,
          payload: { ...c.payload, history: [...c.payload.history, { at: nowIso(), from: c.state, to: "provisional", by: opts.by }] },
        })
        .where(eq(captures.id, c.id));
      return;
    }
    c = await undoResolution(q, user, captureId, opts);
  }
}

/**
 * Takes back the capture's last resolution (toast Undo, reverting the statement's import batch): the rows get their
 * prior values back, an equal split is recomputed for the restored amount, and the capture returns to its previous
 * state and review. The caller refreshes the queue (runMatching) afterwards.
 */
export async function undoResolution(q: Db, user: CurrentUser, captureId: number, opts: { by: string }): Promise<CaptureRow> {
  const c = await getCapture(q, user, captureId);
  const undo = c.payload.undo ?? [];
  const entry = undo.at(-1);
  if (!entry) throw new CaptureError("invalid", "capture_nothing_to_undo", `Capture #${captureId} has nothing to undo`, { id: captureId });
  if (entry.authority && Object.keys(entry.authority.fields).length) {
    await q.update(transactions).set(entry.authority.fields as TxPatch).where(and(eq(transactions.userId, user.id), eq(transactions.id, entry.authority.id)));
  }
  if (entry.row) await q.update(transactions).set(entry.row as TxPatch).where(and(eq(transactions.userId, user.id), eq(transactions.id, c.transactionId!)));
  if (entry.resplit) await applySplit(q, user, c.transactionId!, entry.resplit, { markEdited: false, rememberMerchant: false });
  const now = nowIso();
  const { prev } = entry;
  await q
    .update(captures)
    .set({
      state: prev.state,
      review: prev.review,
      authorityId: prev.authorityId,
      resolvedAt: prev.state === "provisional" ? null : c.resolvedAt,
      payload: {
        ...c.payload,
        ...(prev.text !== undefined ? { text: prev.text } : {}),
        rejected: prev.rejected,
        undo: undo.slice(0, -1),
        history: [...c.payload.history, { at: now, from: c.state, to: prev.state, by: opts.by }],
      },
    })
    .where(eq(captures.id, c.id));
  return await getCapture(q, user, captureId);
}
