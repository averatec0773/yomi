import { InvestSyncBody, SettlementsQuery, SuggestionsQuery } from "@yomi/contracts";
import { CodedError } from "@yomi/core";
import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { errorBody, statusOf } from "./errors";
import { idParam, readJson, readQuery } from "./http";

function app() {
  const r = new Hono();
  r.onError((err, c) => (err instanceof CodedError ? c.json(errorBody(err), statusOf(err)) : c.text("bug", 500)));
  r.post("/sync", async (c) => c.json(await readJson(c, InvestSyncBody, { optional: true })));
  r.post("/strict", async (c) => c.json(await readJson(c, InvestSyncBody)));
  r.get("/settlements", (c) => c.json(readQuery(c, SettlementsQuery)));
  r.get("/suggestions", (c) => c.json(readQuery(c, SuggestionsQuery)));
  r.get("/items/:id", (c) => c.json({ id: idParam(c) }));
  return r;
}

const post = (body?: string) => ({ method: "POST", body });

describe("http helpers", () => {
  it("read valid input as before: optional bodies default, query ids coerce", async () => {
    const a = app();
    expect(await (await a.request("/sync", post())).json()).toEqual({ provider: "all" });
    expect(await (await a.request("/sync", post('{"provider":"ibkr"}'))).json()).toEqual({ provider: "ibkr" });
    expect(await (await a.request("/settlements?participantId=3")).json()).toEqual({ participantId: 3 });
    expect(await (await a.request("/suggestions?month=2026-09")).json()).toEqual({ month: "2026-09" });
    expect(await (await a.request("/items/7")).json()).toEqual({ id: 7 });
  });

  it("answer every unreadable request with a 400 and a translatable code", async () => {
    const a = app();
    const codes = async (path: string, init?: RequestInit) => {
      const res = await a.request(path, init);
      return [res.status, ((await res.json()) as { code: string }).code];
    };
    expect(await codes("/strict", post())).toEqual([400, "invalid_json"]);
    expect(await codes("/sync", post("{"))).toEqual([400, "invalid_json"]);
    expect(await codes("/sync", post('{"provider":"x"}'))).toEqual([400, "validation_failed"]);
    expect(await codes("/settlements?participantId=abc")).toEqual([400, "validation_failed"]);
    expect(await codes("/suggestions?month=2026-13")).toEqual([400, "validation_failed"]);
    expect(await codes("/items/0")).toEqual([400, "invalid_id"]);
  });
});
