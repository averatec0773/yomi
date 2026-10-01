import { toast } from "sonner";
import { fmt } from "@/i18n";
import { getClientDictionary } from "@/i18n/client";
import { errorText } from "@/i18n/errors";

/** Error thrown by apiFetch; `message` is the server's `{error}` text, `code` and `params` its optional code and values. */
export class ApiRequestError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
    readonly params?: Record<string, string | number>,
  ) {
    super(message);
    this.name = "ApiRequestError";
  }
}

export interface ApiInit extends Omit<RequestInit, "body"> {
  /** Serialized as JSON with the right header. Use `body` for FormData and other raw bodies. */
  json?: unknown;
  body?: BodyInit | null;
  /** Do not toast on failure (the caller shows the error itself). */
  silent?: boolean;
}

/**
 * Client-side fetch against the Hono API. `path` may be "/api/..." or just "/..." (prefixed with /api).
 * Resolves to the parsed JSON (undefined for empty bodies). On a non-2xx response it toasts the error
 * (through `errorText`, so a known `code` shows translated; unless `silent`) and throws ApiRequestError.
 */
export async function apiFetch<T = unknown>(path: string, init: ApiInit = {}): Promise<T> {
  const { json, silent, headers, ...rest } = init;
  const url = path.startsWith("/api/") || path === "/api" ? path : `/api${path.startsWith("/") ? "" : "/"}${path}`;
  const h = new Headers(headers);
  let body = rest.body;
  if (json !== undefined) {
    h.set("content-type", "application/json");
    body = JSON.stringify(json);
  }
  const method = rest.method ?? (body != null ? "POST" : "GET");

  let res: Response;
  try {
    res = await fetch(url, { ...rest, method, headers: h, body });
  } catch {
    const err = new ApiRequestError(getClientDictionary().errors.network, 0);
    if (!silent) toast.error(err.message);
    throw err;
  }

  const text = await res.text();
  let data: unknown = undefined;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = text;
    }
  }
  if (!res.ok) {
    const payload = (data && typeof data === "object" ? data : {}) as { error?: unknown; code?: unknown; params?: unknown };
    const t = getClientDictionary();
    const message = typeof payload.error === "string" ? payload.error : fmt(t.errors.requestFailed, { status: res.status });
    const params = payload.params && typeof payload.params === "object" ? (payload.params as Record<string, string | number>) : undefined;
    const err = new ApiRequestError(message, res.status, typeof payload.code === "string" ? payload.code : undefined, params);
    if (!silent) toast.error(errorText(err, t));
    throw err;
  }
  return data as T;
}
