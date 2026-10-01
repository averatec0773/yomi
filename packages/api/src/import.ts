import type { ApiError, BatchList, ImportPreview, ImportResult, RevertResult } from "@yomi/contracts";
import { CodedError, commitImport, getCurrentUser, ImportError, listBatches, type ParseFn, previewImport, revertBatch } from "@yomi/core";
import type { Db } from "@yomi/db";
import { Hono } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";

const ERROR_STATUS: Record<ImportError["kind"], ContentfulStatusCode> = {
  already_imported: 409,
  batch_not_found: 404,
  batch_already_reverted: 409,
};

function truthy(v: unknown): boolean {
  return typeof v === "string" && ["1", "true", "yes", "on"].includes(v.trim().toLowerCase());
}

export function importRoutes(deps: { getDb: () => Db | Promise<Db>; parse: ParseFn }): Hono {
  const r = new Hono();

  r.onError((err, c) => {
    if (err instanceof ImportError) {
      return c.json({ error: err.message, code: err.code, params: err.params } satisfies ApiError, ERROR_STATUS[err.kind]);
    }
    throw err;
  });

  async function readUpload(body: Record<string, unknown>) {
    const file = body.file;
    if (!(file instanceof File)) return null;
    return { bytes: new Uint8Array(await file.arrayBuffer()), fileName: file.name || "upload" };
  }

  /** A file the parsers reject: its ParseError code, or `import_parse_failed` with the raw message. */
  async function withParseErrors<T>(fn: () => Promise<T>): Promise<T | { parseError: ApiError }> {
    try {
      return await fn();
    } catch (e) {
      if (e instanceof ImportError) throw e;
      if (e instanceof CodedError) return { parseError: { error: e.message, code: e.code, params: e.params } };
      const message = e instanceof Error ? e.message : String(e);
      return { parseError: { error: message, code: "import_parse_failed", params: { message } } };
    }
  }
  const missingFile: ApiError = { error: "Missing the file field `file`", code: "import_file_missing" };

  r.post("/preview", async (c) => {
    const upload = await readUpload(await c.req.parseBody());
    if (!upload) return c.json(missingFile, 400);
    const out = await withParseErrors(async () =>
      previewImport(await deps.getDb(), getCurrentUser(), deps.parse, upload.bytes, upload.fileName),
    );
    if ("parseError" in out) return c.json(out.parseError, 422);
    return c.json(out satisfies ImportPreview);
  });

  r.post("/commit", async (c) => {
    const body = await c.req.parseBody();
    const upload = await readUpload(body);
    if (!upload) return c.json(missingFile, 400);
    const force = truthy(body.force) || truthy(c.req.query("force"));
    const out = await withParseErrors(async () =>
      commitImport(await deps.getDb(), getCurrentUser(), deps.parse, upload.bytes, upload.fileName, { force }),
    );
    if ("parseError" in out) return c.json(out.parseError, 422);
    return c.json(out satisfies ImportResult);
  });

  r.get("/batches", async (c) => {
    const batches = await listBatches(await deps.getDb(), getCurrentUser());
    return c.json({ batches } as BatchList);
  });

  r.post("/batches/:id/revert", async (c) => {
    const id = Number(c.req.param("id"));
    if (!Number.isInteger(id) || id <= 0) return c.json({ error: "Invalid batch id", code: "invalid_id", params: { name: "id" } } satisfies ApiError, 400);
    return c.json((await revertBatch(await deps.getDb(), getCurrentUser(), id)) satisfies RevertResult);
  });

  return r;
}
