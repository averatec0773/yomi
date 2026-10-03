import { seed } from "@yomi/core";
import { testDb } from "@yomi/db/testing";
import { describe, expect, it } from "vitest";
import { createApi } from "./index";

async function setup() {
  const db = await testDb();
  await seed(db);
  return createApi({ getDb: () => db });
}

describe("api", () => {
  it("GET /api/health", async () => {
    const res = await (await setup()).request("/api/health");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });
});
