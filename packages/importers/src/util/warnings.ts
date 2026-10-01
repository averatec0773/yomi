import { type Notice, notice } from "../errors";

/** Shared parse warnings; `line` is the 1-based row among the file's transactions. */
export const unknownBucket = (line: number, value: string): Notice =>
  notice("import_unknown_bucket", `Row ${line}: unknown 收/支 value ${JSON.stringify(value)}, treated as neutral`, { line, value });

export const neutralDirectionUnknown = (line: number): Notice =>
  notice("import_neutral_direction_unknown", `Row ${line}: cannot tell which way a neutral row went, treated as money out`, { line });

export const countMismatch = (declared: number, parsed: number): Notice =>
  notice("import_count_mismatch", `The file declares ${declared} rows, parsed ${parsed}`, { declared, parsed });
