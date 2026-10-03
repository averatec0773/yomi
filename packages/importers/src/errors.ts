/** Interpolation values for a coded message; the UI fills `{name}` placeholders in its dictionary text. */
export type MessageParams = Record<string, string | number>;

/**
 * A user-visible condition with a stable snake_case `code`, `params` for the UI's translation and an
 * English `message` for logs and API clients without a dictionary.
 */
export interface Notice {
  code: string;
  params: MessageParams;
  message: string;
}

export function notice(code: string, message: string, params: MessageParams = {}): Notice {
  return { code, params, message };
}

/**
 * What a caller can do about a CodedError, the same in every module: fix the input (`invalid`), stop (`forbidden`),
 * look elsewhere (`not_found`), resolve the state first (`conflict`), wait (`rate_limited`), or retry later
 * (`unavailable`, `timeout`: an outside service failed or took too long). HTTP and MCP map it to a status; `code`
 * stays the specific condition the UI translates.
 */
export type ErrorKind = "invalid" | "forbidden" | "not_found" | "conflict" | "rate_limited" | "unavailable" | "timeout";

/** Error with a coarse `kind`, a stable `code` and `params`; the message is English. Core's error classes extend it. */
export class CodedError extends Error {
  constructor(
    readonly kind: ErrorKind,
    readonly code: string,
    message: string,
    readonly params: MessageParams = {},
  ) {
    super(message);
    this.name = "CodedError";
  }
}

/** A statement file that cannot be parsed (unknown format, missing header or columns, bad cell). */
export class ParseError extends CodedError {
  constructor(code: string, message: string, params: MessageParams = {}) {
    super("invalid", code, message, params);
    this.name = "ParseError";
  }
}
