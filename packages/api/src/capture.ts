import {
  BulkResolveBody,
  BulkTransactionReviewBody,
  type BulkTransactionReviewResult,
  ResolveBody,
  type ResolveResult,
  type ReviewList,
  TransactionReviewBody,
  type TransactionReviewResult,
  TransactionReviewUndoBody,
} from "@yomi/contracts";
import {
  confirmOwnTransfers,
  getCurrentUser,
  listReview,
  resolveReview,
  resolveReviewBulk,
  resolveTransactionReview,
  undoCapture,
  undoTransactionReview,
} from "@yomi/core";
import type { Db } from "@yomi/db";
import { Hono } from "hono";
import { idParam, readJson } from "./http";

/**
 * The review queue (thin over core/capture; the v0.3 MCP tools call the same functions):
 * GET /review · POST /review/bulk · POST /review/:captureId · POST /captures/:captureId/undo, and for items about ledger
 * rows POST /review/transactions/bulk · POST /review/transactions/:transactionId · POST /review/transactions/:transactionId/undo.
 */
export function captureRoutes(deps: { getDb: () => Db | Promise<Db>; today?: () => string }): Hono {
  const r = new Hono();
  const db = async () => await deps.getDb();
  const user = () => getCurrentUser();

  r.get("/review", async (c) => c.json((await listReview(await db(), user(), { today: deps.today?.() })) satisfies ReviewList));
  r.post("/review/bulk", async (c) => {
    const body = await readJson(c, BulkResolveBody);
    return c.json((await resolveReviewBulk(await db(), user(), body)) satisfies ResolveResult);
  });
  r.post("/review/transactions/bulk", async (c) => {
    const body = await readJson(c, BulkTransactionReviewBody);
    return c.json({ results: await confirmOwnTransfers(await db(), user(), body.transactionIds) } satisfies BulkTransactionReviewResult);
  });
  r.post("/review/transactions/:transactionId", async (c) => {
    const id = idParam(c, "transactionId");
    const body = await readJson(c, TransactionReviewBody);
    return c.json((await resolveTransactionReview(await db(), user(), id, body)) satisfies TransactionReviewResult);
  });
  r.post("/review/transactions/:transactionId/undo", async (c) => {
    const id = idParam(c, "transactionId");
    const body = await readJson(c, TransactionReviewUndoBody);
    return c.json((await undoTransactionReview(await db(), user(), id, body)) satisfies TransactionReviewResult);
  });
  r.post("/review/:captureId", async (c) => {
    const id = idParam(c, "captureId");
    const body = await readJson(c, ResolveBody);
    return c.json((await resolveReview(await db(), user(), id, body)) satisfies ResolveResult);
  });
  r.post("/captures/:captureId/undo", async (c) => {
    return c.json((await undoCapture(await db(), user(), idParam(c, "captureId"))) satisfies ResolveResult);
  });
  return r;
}
