import { CodedError, type ErrorKind, type MessageParams } from "@yomi/importers";

export class LedgerError extends CodedError {
  constructor(kind: ErrorKind, code: string, message: string, params: MessageParams = {}) {
    super(kind, code, message, params);
    this.name = "LedgerError";
  }
}
