import { ApiError, BatchList, ImportPreview, ImportResult, RevertResult } from "@yomi/contracts";
import { seed } from "@yomi/core";
import { testDb } from "@yomi/db/testing";
import type { NormalizedRow, ParseResult } from "@yomi/importers";
import { describe, expect, it } from "vitest";
import { createApi } from "./index";

function row(i: number, amountMinor: number): NormalizedRow {
  return {
    source: "wechat",
    lineNo: i,
    externalId: `w${i}`,
    occurredAt: `2026-09-0${i}T10:00:00+08:00`,
    amountMinor,
    currency: "CNY",
    originalAmountMinor: null,
    originalCurrency: null,
    direction: amountMinor < 0 ? "out" : "in",
    kind: amountMinor < 0 ? "expense" : "income",
    status: "ok",
    counterparty: "某商户",
    description: "商品",
    sourceCategory: "商户消费",
    paymentMethod: "零钱",
    raw: {},
  };
}

async function setup() {
  const db = await testDb();
  await seed(db);
  const parse = async (bytes: Uint8Array): Promise<ParseResult> => {
    if (new TextDecoder().decode(bytes) === "garbage") throw new Error("unrecognized statement file");
    return {
      source: "wechat",
      rows: [row(1, -1200), row(2, -300), row(3, 5000)],
      declared: { count: 3, expense: { count: 2, minor: 1500 }, income: { count: 1, minor: 5000 } },
      warnings: [],
    };
  };
  return createApi({ getDb: () => db, parse });
}

function upload(content: string, extra: Record<string, string> = {}) {
  const form = new FormData();
  form.set("file", new File([content], "wechat.xlsx"));
  for (const [k, v] of Object.entries(extra)) form.set(k, v);
  return { method: "POST", body: form };
}

describe("api", () => {
  it("GET /api/health", async () => {
    const res = await (await setup()).request("/api/health");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  it("preview, commit, refuse re-commit, force, list, revert", async () => {
    const app = await setup();

    const pre = await app.request("/api/import/preview", upload("file-1"));
    expect(pre.status).toBe(200);
    const preview = ImportPreview.parse(await pre.json());
    expect(preview).toMatchObject({ rowsTotal: 3, newCount: 3, alreadyImported: false });
    expect(preview.reconciliation.ok).toBe(true);
    expect(preview.spending).toEqual([{ currency: "CNY", count: 2, spendingMinor: 1500 }]);

    const com = await app.request("/api/import/commit", upload("file-1"));
    expect(com.status).toBe(200);
    const result = ImportResult.parse(await com.json());
    expect(result).toMatchObject({ inserted: 3, skippedDup: 0 });

    const again = await app.request("/api/import/commit", upload("file-1"));
    expect(again.status).toBe(409);
    expect(ApiError.parse(await again.json()).code).toBe("import_already_imported");

    const forced = await app.request("/api/import/commit", upload("file-1", { force: "true" }));
    expect(forced.status).toBe(200);
    expect(ImportResult.parse(await forced.json())).toMatchObject({ inserted: 0, skippedDup: 3 });

    const list = BatchList.parse(await (await app.request("/api/import/batches")).json());
    expect(list.batches.map((b) => b.id)).toEqual([1]);
    expect(list.batches[0]).toMatchObject({ status: "committed", rowsInserted: 3, declared: { count: 3 } });

    const rev = await app.request(`/api/import/batches/${result.batchId}/revert`, { method: "POST" });
    expect(rev.status).toBe(200);
    expect(RevertResult.parse(await rev.json())).toEqual({ batchId: result.batchId, deleted: 3, keptEdited: 0 });

    const rev2 = await app.request(`/api/import/batches/${result.batchId}/revert`, { method: "POST" });
    expect(rev2.status).toBe(409);
    expect((await app.request("/api/import/batches/999/revert", { method: "POST" })).status).toBe(404);
    expect((await app.request("/api/import/batches/abc/revert", { method: "POST" })).status).toBe(400);
  });

  it("rejects a missing file and reports parse failures", async () => {
    const app = await setup();
    const missing = await app.request("/api/import/preview", { method: "POST", body: new FormData() });
    expect(missing.status).toBe(400);
    const bad = await app.request("/api/import/preview", upload("garbage"));
    expect(bad.status).toBe(422);
    expect(ApiError.parse(await bad.json())).toMatchObject({ code: "import_parse_failed", params: { message: "unrecognized statement file" } });
    expect(ApiError.parse(await missing.json())).toMatchObject({ code: "import_file_missing" });
  });
});
