import { BulkResolveBody, ResolveBody, type ResolveResult, type ReviewList } from "@yomi/contracts";
import { CaptureError, getCurrentUser, getTimeZone, listReview, resolveReview, resolveReviewBulk, todayIn, undoCapture } from "@yomi/core";
import type { Db } from "@yomi/db";
import { Hono } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { BadRequest, errorBody, idParam, readJson } from "./split";

const CAPTURE_ERROR_STATUS: Record<CaptureError["kind"], ContentfulStatusCode> = { not_found: 404, invalid: 409 };

/**
 * The capture review queue (thin over core/capture; the v0.3 MCP tools call the same functions):
 * GET /review · POST /review/bulk · POST /review/:captureId · POST /captures/:captureId/undo.
 */
export function captureRoutes(deps: { getDb: () => Db | Promise<Db>; today?: () => string }): Hono {
  const r = new Hono();
  r.onError((err, c) => {
    if (err instanceof CaptureError) return c.json(errorBody(err), CAPTURE_ERROR_STATUS[err.kind]);
    if (err instanceof BadRequest) return c.json(errorBody(err), 400);
    throw err;
  });
  const db = async () => await deps.getDb();
  const user = () => getCurrentUser();

  r.get("/review", async (c) => {
    const today = deps.today?.() ?? todayIn(await getTimeZone(await db(), user()));
    return c.json((await listReview(await db(), user(), { today })) satisfies ReviewList);
  });
  r.post("/review/bulk", async (c) => {
    const body = await readJson(c, BulkResolveBody);
    return c.json((await resolveReviewBulk(await db(), user(), body)) satisfies ResolveResult);
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
