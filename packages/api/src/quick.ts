import { QuickCreateBody, QuickCreated, QuickDraft, QuickParseBody } from "@yomi/contracts";
import { createQuickEntry, createSmsEntry, getCurrentUser, getTimeZone, listParticipants, parseQuickEntry, todayIn } from "@yomi/core";
import type { Db } from "@yomi/db";
import { Hono } from "hono";
import { readJson } from "./split";

export function quickRoutes(deps: { getDb: () => Db | Promise<Db> }): Hono {
  const r = new Hono();

  r.post("/parse", async (c) => {
    const body = await readJson(c, QuickParseBody);
    const timeZone = await getTimeZone(await deps.getDb(), getCurrentUser());
    const draft = parseQuickEntry(body.text, {
      today: body.today ?? todayIn(timeZone),
      timeZone,
      participants: (await listParticipants(await deps.getDb(), getCurrentUser())).map((p) => ({
        id: p.id,
        name: p.name,
        isSelf: p.isSelf,
        aliases: p.identities.filter((i) => i.kind !== "zelle_email" && i.kind !== "zelle_phone").map((i) => i.value),
      })),
      defaultCurrency: body.defaultCurrency ?? "CNY",
    });
    return c.json(draft satisfies QuickDraft);
  });

  r.post("/", async (c) => {
    const body = await readJson(c, QuickCreateBody);
    if (body.smsText) {
      const out = await createSmsEntry(await deps.getDb(), getCurrentUser(), {
        text: body.smsText,
        today: body.today ?? todayIn(await getTimeZone(await deps.getDb(), getCurrentUser())),
        participantIds: body.participantIds,
        mode: body.mode,
      });
      return c.json(out satisfies QuickCreated, out.alreadyAdded ? 200 : 201);
    }
    return c.json((await createQuickEntry(await deps.getDb(), getCurrentUser(), body)) satisfies QuickCreated, 201);
  });

  return r;
}
