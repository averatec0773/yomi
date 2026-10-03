import { type ApiError, MonthString, type MonthOverview, SetTargetInput, StatsQuery, type StatsResponse, type Target } from "@yomi/contracts";
import { getCurrentUser, getTimeZone, matchPreset, monthOverview, rangeOverview, resolvePeriod, setMonthlyTarget, todayIn } from "@yomi/core";
import type { Db } from "@yomi/db";
import { Hono } from "hono";
import { parseJson } from "./ledger";

/** Routes: GET /month/:month, GET /stats, PUT /targets (mounted under /api). */
export function monthRoutes(deps: { getDb: () => Db | Promise<Db>; today?: () => string }): Hono {
  const r = new Hono();

  r.get("/month/:month", async (c) => {
    const month = c.req.param("month");
    if (!MonthString.safeParse(month).success) {
      return c.json({ error: "The month must be YYYY-MM", code: "invalid_month", params: { value: month } } satisfies ApiError, 400);
    }
    return c.json((await monthOverview(await deps.getDb(), getCurrentUser(), month)) satisfies MonthOverview);
  });

  r.get("/stats", async (c) => {
    const q = await parseJson(c, StatsQuery, c.req.query());
    if (!q.ok) return q.res;
    const today = deps.today?.() ?? todayIn(await getTimeZone(await deps.getDb(), getCurrentUser()));
    const { preset, from, to } = q.data;
    const range =
      from !== undefined && to !== undefined
        ? resolvePeriod({ preset: "custom", from, to }, today)
        : resolvePeriod({ preset: preset && preset !== "custom" ? preset : "this_month" }, today);
    const overview = await rangeOverview(await deps.getDb(), getCurrentUser(), range, { today });
    return c.json({ preset: matchPreset(range, today), ...overview } satisfies StatsResponse);
  });

  r.put("/targets", async (c) => {
    const b = await parseJson(c, SetTargetInput);
    if (!b.ok) return b.res;
    return c.json((await setMonthlyTarget(await deps.getDb(), getCurrentUser(), b.data)) satisfies Target);
  });

  return r;
}
