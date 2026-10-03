import { CodedError, type MessageParams } from "@yomi/core";
import type { Context } from "hono";

/** The part of a zod schema these helpers use (zod itself is not an api dependency). */
interface Schema<T> {
  safeParse(
    v: unknown,
  ): { success: true; data: T } | { success: false; error: { issues: { path: PropertyKey[]; message: string }[] } };
}

/** A request the route cannot read: answered 400 with its code. */
export class BadRequest extends CodedError {
  constructor(code: string, message: string, params: MessageParams = {}) {
    super("invalid", code, message, params);
    this.name = "BadRequest";
  }
}

/** `value` checked against `schema`; `validation_failed` naming each bad field (under `root` when the issue has no path). */
export function validated<T>(schema: Schema<T>, value: unknown, root: string): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    const details = parsed.error.issues.map((i) => `${i.path.map(String).join(".") || root}: ${i.message}`).join("; ");
    throw new BadRequest("validation_failed", `Invalid request: ${details}`, { details });
  }
  return parsed.data;
}

export interface ReadJsonOptions {
  /** An empty body reads as `{}` (for bodies whose fields all have defaults). */
  optional?: boolean;
  /** Thrown instead of `invalid_json` / `validation_failed`, for a route that answers any unreadable body with one code. */
  invalid?: () => CodedError;
}

/** The JSON body, validated; `invalid_json` when it is not JSON. */
export async function readJson<T>(c: Context, schema: Schema<T>, opts: ReadJsonOptions = {}): Promise<T> {
  const text = await c.req.text();
  let raw: unknown = {};
  if (!opts.optional || text.trim()) {
    try {
      raw = JSON.parse(text);
    } catch {
      throw opts.invalid?.() ?? new BadRequest("invalid_json", "The request body is not valid JSON");
    }
  }
  if (opts.invalid && !schema.safeParse(raw).success) throw opts.invalid();
  return validated(schema, raw, "body");
}

/** The query string, validated. */
export function readQuery<T>(c: Context, schema: Schema<T>): T {
  return validated(schema, c.req.query(), "query");
}

/** One path parameter, validated. */
export function readParam<T>(c: Context, name: string, schema: Schema<T>): T {
  return validated(schema, c.req.param(name), name);
}

/** A positive integer path parameter; `invalid_id` otherwise. */
export function idParam(c: Context, name = "id"): number {
  const id = Number(c.req.param(name));
  if (!Number.isInteger(id) || id <= 0) throw new BadRequest("invalid_id", `Invalid ${name}`, { name });
  return id;
}
