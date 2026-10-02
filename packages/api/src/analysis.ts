import { AnalysisQuery, type AnalysisReport, type FreshnessResponse } from "@yomi/contracts";
import { analysisReport, getCurrentUser, getTimeZone, loadSourceFacts, resolveAnalysisPeriod, sourceFreshness, todayIn } from "@yomi/core";
import type { Db } from "@yomi/db";
import { Hono } from "hono";
import { ledgerErrorHandler, parseJson } from "./ledger";

/** Routes: GET /analysis, GET /analysis/freshness (mounted under /api). */
export function analysisRoutes(deps: { getDb: () => Db | Promise<Db>; today?: () => string; env?: NodeJS.ProcessEnv }): Hono {
  const r = new Hono();
  r.onError(ledgerErrorHandler);

  const context = async () => {
    const db = await deps.getDb();
    const user = getCurrentUser();
    const timeZone = await getTimeZone(db, user);
    return { db, user, timeZone, today: deps.today?.() ?? todayIn(timeZone) };
  };

  r.get("/analysis", async (c) => {
    const q = await parseJson(c, AnalysisQuery, c.req.query());
    if (!q.ok) return q.res;
    const { db, user, today } = await context();
    const { period, date, preset, from, to } = q.data;
    const range = resolveAnalysisPeriod(
      period ? { period, date } : preset ? { preset } : from !== undefined && to !== undefined ? { from, to } : { period: "month" },
      today,
    );
    return c.json((await analysisReport(db, user, range, { today, env: deps.env })) satisfies AnalysisReport);
  });

  r.get("/analysis/freshness", async (c) => {
    const { db, user, timeZone, today } = await context();
    const sources = sourceFreshness(await loadSourceFacts(db, user, { timeZone, env: deps.env }), today);
    return c.json({ today, sources } satisfies FreshnessResponse);
  });

  return r;
}
