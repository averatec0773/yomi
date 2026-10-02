import type { SourceFreshness } from "@yomi/core";
import type { Dictionary } from "../i18n/en";
import { fmt } from "../i18n/format";

type FileSource = keyof Dictionary["analysis"]["sources"]["viaFile"];

/** The institution behind each file source, as a Plaid login names it. */
const FILE_INSTITUTIONS: Record<FileSource, string> = { boa_csv: "Bank of America", icbc_pdf: "ICBC" };

const isFileSource = (s: string): s is FileSource => s in FILE_INSTITUTIONS;
const same = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

/**
 * When one institution reaches the ledger both through a Plaid login and a file import, both names say which is which
 * ("Bank of America (Plaid)", "Bank of America (CSV)"). The new name goes in `label`, which sourceName reads first.
 */
export function distinctSourceNames<F extends Pick<SourceFreshness, "source" | "label">>(fresh: readonly F[], t: Dictionary): F[] {
  const logins = fresh.filter((f) => f.source === "plaid" && f.label).map((f) => f.label!);
  const files = fresh.map((f) => f.source).filter(isFileSource);
  return fresh.map((f) => {
    if (f.source === "plaid" && f.label && files.some((s) => same(FILE_INSTITUTIONS[s], f.label!))) {
      return { ...f, label: fmt(t.analysis.sources.viaPlaid, { name: f.label }) };
    }
    if (isFileSource(f.source) && logins.some((l) => same(l, FILE_INSTITUTIONS[f.source as FileSource]))) {
      return { ...f, label: t.analysis.sources.viaFile[f.source] };
    }
    return f;
  });
}
