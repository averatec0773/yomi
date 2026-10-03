import { MonthString, type MonthOverview, SetTargetInput, StatsQuery, type StatsResponse, type Target } from "@yomi/contracts";
import { getCurrentUser, monthOverview, setMonthlyTarget, statsFor } from "@yomi/core";
import type { Db } from "@yomi/db";
import { Hono } from "hono";
import { BadRequest, readJson, readQuery } from "./http";

/** Routes: GET /month/:month, GET /stats, PUT /targets (mounted under /api). */
export function monthRoutes(deps: { getDb: () => Db | Promise<Db>; today?: () => string }): Hono {
  const r = new Hono();

  r.get("/month/:month", async (c) => {
    const month = c.req.param("month");
    if (!MonthString.safeParse(month).success) throw new BadRequest("invalid_month", "The month must be YYYY-MM", { value: month });
    return c.json((await monthOverview(await deps.getDb(), getCurrentUser(), month)) satisfies MonthOverview);
  });

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
