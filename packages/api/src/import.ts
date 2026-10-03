import { type ApiError, type BatchList, ImportFlags, type ImportPreview, type ImportResult, type RevertResult } from "@yomi/contracts";
import { CodedError, commitImport, getCurrentUser, ImportError, listBatches, type ParseFn, previewImport, revertBatch } from "@yomi/core";
import type { Db } from "@yomi/db";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { BadRequest, idParam, readQuery, validated } from "./http";

/** Largest upload (the whole form body) accepted, checked before it is read; apps/web/next.config.ts lets it through the proxy. */
const MAX_UPLOAD_MB = 25;

export function importRoutes(deps: { getDb: () => Db | Promise<Db>; parse: ParseFn }): Hono {
  const r = new Hono();

  async function readUpload(body: Record<string, unknown>) {
    const file = body.file;
    if (!(file instanceof File)) throw new BadRequest("import_file_missing", "Missing the file field `file`");
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
  const uploadLimit = bodyLimit({
    maxSize: MAX_UPLOAD_MB * 1024 * 1024,
    onError: (c) =>
      c.json({ error: `The file is larger than ${MAX_UPLOAD_MB} MB`, code: "import_file_too_large", params: { maxMb: MAX_UPLOAD_MB } } satisfies ApiError, 413),
  });

  r.post("/preview", uploadLimit, async (c) => {
    const upload = await readUpload(await c.req.parseBody());
    const out = await withParseErrors(async () =>
      previewImport(await deps.getDb(), getCurrentUser(), deps.parse, upload.bytes, upload.fileName),
    );
    if ("parseError" in out) return c.json(out.parseError, 422);
    return c.json(out satisfies ImportPreview);
  });

  r.post("/commit", uploadLimit, async (c) => {
    const body = await c.req.parseBody();
    const upload = await readUpload(body);
    // `force` as a form field or in the query string.
    const force = Boolean(validated(ImportFlags, { force: body.force }, "body").force || readQuery(c, ImportFlags).force);
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

  r.post("/batches/:id/revert", async (c) =>
    c.json((await revertBatch(await deps.getDb(), getCurrentUser(), idParam(c))) satisfies RevertResult),
  );

  return r;
}
