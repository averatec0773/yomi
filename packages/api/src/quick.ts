import { QuickCreateBody, QuickCreated, QuickDraft, QuickParseBody } from "@yomi/contracts";
import { createQuickEntry, createSmsEntry, getCurrentUser, quickDraft } from "@yomi/core";
import type { Db } from "@yomi/db";
import { Hono } from "hono";
import { readJson } from "./http";

export function quickRoutes(deps: { getDb: () => Db | Promise<Db> }): Hono {
  const r = new Hono();

  r.post("/parse", async (c) => {
    const body = await readJson(c, QuickParseBody);
    return c.json((await quickDraft(await deps.getDb(), getCurrentUser(), body)) satisfies QuickDraft);
  });

  r.post("/", async (c) => {
    const body = await readJson(c, QuickCreateBody);
    if (body.smsText) {
      const out = await createSmsEntry(await deps.getDb(), getCurrentUser(), {
        text: body.smsText,
        today: body.today,
        participantIds: body.participantIds,
        mode: body.mode,
      });
      return c.json(out satisfies QuickCreated, out.alreadyAdded ? 200 : 201);
    }
    return c.json((await createQuickEntry(await deps.getDb(), getCurrentUser(), body)) satisfies QuickCreated, 201);
  });

  return r;
}
