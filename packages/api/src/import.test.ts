import { ApiError, BatchList, ImportPreview, ImportResult, RevertResult } from "@yomi/contracts";
import { seed } from "@yomi/core";
import { testDb } from "@yomi/db/testing";
import { type NormalizedRow, ParseError, type ParseResult } from "@yomi/importers";
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
    const text = new TextDecoder().decode(bytes);
    if (text === "garbage") throw new Error("unrecognized statement file");
    if (text === "bad-amount") throw new ParseError("import_bad_amount", 'Cannot parse amount: "1.234"', { value: "1.234" });
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

describe("import routes", () => {
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

  it("maps a coded parser error to 422 with its code and params, on preview and commit alike, and writes nothing", async () => {
    const app = await setup();
    for (const path of ["/api/import/preview", "/api/import/commit"]) {
      const res = await app.request(path, upload("bad-amount"));
      expect(res.status, path).toBe(422);
      expect(ApiError.parse(await res.json())).toMatchObject({ code: "import_bad_amount", params: { value: "1.234" } });
    }
    const garbage = await app.request("/api/import/commit", upload("garbage"));
    expect(garbage.status).toBe(422);
    expect(BatchList.parse(await (await app.request("/api/import/batches")).json()).batches).toEqual([]);
  });

  it("takes force from the query string too, and rejects a malformed one", async () => {
    const app = await setup();
    expect((await app.request("/api/import/commit", upload("file-1"))).status).toBe(200);
    const forced = await app.request("/api/import/commit?force=true", upload("file-1"));
    expect(forced.status).toBe(200);
    expect(ImportResult.parse(await forced.json())).toMatchObject({ inserted: 0, skippedDup: 3 });
    const bad = await app.request("/api/import/commit?force=maybe", upload("file-1"));
    expect(bad.status).toBe(400);
    expect(ApiError.parse(await bad.json()).code).toBe("validation_failed");
  });

  it("refuses an upload over 25 MB with 413 before reading it, and accepts one just under", async () => {
    const app = await setup();
    const MB = 1024 * 1024;
    for (const path of ["/api/import/preview", "/api/import/commit"]) {
      const big = await app.request(path, upload("x".repeat(25 * MB + 1)));
      expect(big.status).toBe(413);
      expect(ApiError.parse(await big.json())).toMatchObject({ code: "import_file_too_large", params: { maxMb: 25 } });
      // A declared Content-Length is refused without reading the body.
      const declared = await app.request(path, { method: "POST", headers: { "Content-Type": "multipart/form-data; boundary=x", "Content-Length": String(30 * MB) }, body: "--x--" });
      expect(declared.status).toBe(413);
    }
    expect((await app.request("/api/import/preview", upload("x".repeat(24 * MB)))).status).toBe(200);
    expect(BatchList.parse(await (await app.request("/api/import/batches")).json()).batches).toEqual([]);
  });
});
