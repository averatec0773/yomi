/**
 * Minimal RFC 4180 style CSV reader: quoted fields (with "" escapes and embedded
 * newlines), CRLF or LF line endings, mixed within one file (Alipay exports use CRLF
 * in the preamble and LF in the data rows). Returns every line, including blank ones,
 * so callers can locate the header and stop at the first blank line.
 */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
      continue;
    }
    if (ch === '"' && field === "") {
      inQuotes = true;
    } else if (ch === ",") {
      row.push(field);
      field = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else {
      field += ch;
    }
  }
  if (field !== "" || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

export function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

/** Trims spaces and tabs (exports pad ids with a trailing \t to stop Excel from mangling them). */
export function clean(cell: string | undefined): string {
  return (cell ?? "").replace(/^[\s\t]+|[\s\t]+$/g, "");
}

export function isBlankRow(cells: readonly string[]): boolean {
  return cells.every((c) => clean(c) === "");
}
