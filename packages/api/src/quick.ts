import { QuickAccountList, QuickCreateBody, QuickCreated, QuickDraft, QuickIncomeBody, QuickParseBody, QuickRowsCreated, QuickTransferBody } from "@yomi/contracts";
import { createIncomeEntry, createQuickEntry, createSmsEntry, createTransferEntry, getCurrentUser, quickAccounts, quickDraft } from "@yomi/core";
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

  r.get("/accounts", async (c) => c.json({ accounts: await quickAccounts(await deps.getDb(), getCurrentUser()) } satisfies QuickAccountList));

  r.post("/income", async (c) => {
    const body = await readJson(c, QuickIncomeBody);
    const out = await createIncomeEntry(await deps.getDb(), getCurrentUser(), { ...body, note: body.note ?? null });
    return c.json(out satisfies QuickRowsCreated, 201);
  });

  r.post("/transfer", async (c) => {
    const body = await readJson(c, QuickTransferBody);
    return c.json((await createTransferEntry(await deps.getDb(), getCurrentUser(), body)) satisfies QuickRowsCreated, 201);
  });

  return r;
}
