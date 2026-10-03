import type { ApiError } from "@yomi/contracts";
import type { CodedError, ErrorKind } from "@yomi/core";
import type { ContentfulStatusCode } from "hono/utils/http-status";

const STATUS: Record<ErrorKind, ContentfulStatusCode> = {
  invalid: 400,
  forbidden: 403,
  not_found: 404,
  conflict: 409,
  rate_limited: 429,
  unavailable: 502,
  timeout: 504,
};

/** The HTTP status of a coded error, from its kind alone; one table for every route (and the MCP endpoint's isError results). */
export function statusOf(err: CodedError): ContentfulStatusCode {
  return STATUS[err.kind];
}

/** Body of an error response: English message, stable code, params for the UI's translation. */
export function errorBody(err: CodedError): ApiError {
  return { error: err.message, code: err.code, params: err.params };
}
