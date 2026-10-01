import { CodedError, type MessageParams } from "@yomi/importers";

/** HTTP-level class of a LedgerError; `code` names the specific condition. */
export type LedgerErrorKind =
  | "not_found"
  | "category_not_found"
  | "category_kind_mismatch"
  | "system_category"
  | "duplicate_name"
  | "invalid_input"
  | "split_conflict";

export class LedgerError extends CodedError {
  constructor(
    readonly kind: LedgerErrorKind,
    code: string,
    message: string,
    params: MessageParams = {},
  ) {
    super(code, message, params);
    this.name = "LedgerError";
  }
}
