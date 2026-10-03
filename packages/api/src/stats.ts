import { SetTargetInput, StatsQuery, type StatsResponse, type Target } from "@yomi/contracts";
import { getCurrentUser, setMonthlyTarget, statsFor } from "@yomi/core";
import type { Db } from "@yomi/db";
import { Hono } from "hono";
import { readJson, readQuery } from "./http";

/** Routes: GET /stats, PUT /targets (mounted under /api). */
export function statsRoutes(deps: { getDb: () => Db | Promise<Db>; today?: () => string }): Hono {
  const r = new Hono();

  r.get("/stats", async (c) => {
    const q = readQuery(c, StatsQuery);
    return c.json((await statsFor(await deps.getDb(), getCurrentUser(), q, { today: deps.today?.() })) satisfies StatsResponse);
  });

  r.put("/targets", async (c) => {
    const body = await readJson(c, SetTargetInput);
    return c.json((await setMonthlyTarget(await deps.getDb(), getCurrentUser(), body)) satisfies Target);
  });

  return r;
}
