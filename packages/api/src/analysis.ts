import { AnalysisQuery, type AnalysisReport, type FreshnessResponse } from "@yomi/contracts";
import { analysisFor, freshnessFor, getCurrentUser } from "@yomi/core";
import type { Db } from "@yomi/db";
import { Hono } from "hono";
import { readQuery } from "./http";

/** Routes: GET /analysis, GET /analysis/freshness (mounted under /api). */
export function analysisRoutes(deps: { getDb: () => Db | Promise<Db>; today?: () => string; env?: NodeJS.ProcessEnv }): Hono {
  const r = new Hono();
  const opts = () => ({ today: deps.today?.(), env: deps.env });

  r.get("/analysis", async (c) => {
    const q = readQuery(c, AnalysisQuery);
    return c.json((await analysisFor(await deps.getDb(), getCurrentUser(), q, opts())) satisfies AnalysisReport);
  });

  r.get("/analysis/freshness", async (c) => c.json((await freshnessFor(await deps.getDb(), getCurrentUser(), opts())) satisfies FreshnessResponse));

  return r;
}
