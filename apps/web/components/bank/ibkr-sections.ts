import type { IbkrSectionItem } from "@yomi/contracts";
import type { Dictionary } from "@/i18n/en";
// Relative, so the unit tests (no "@/" alias) can load it.
import { fmt } from "../../i18n/format";

export type IbkrSectionId = IbkrSectionItem["id"];

/**
 * What the pulls say about the query's sections: null when none is missing, else each missing one with its name
 * and what yomi will lack without it, in the order yomi reads them. `unknown` sections are not missing.
 */
export function missingSectionNotes(sections: IbkrSectionItem[], t: Dictionary): { id: IbkrSectionId; name: string; effect: string }[] | null {
  const i = t.secrets.ibkr;
  const missing = sections.filter((s) => s.state === "missing");
  if (missing.length === 0) return null;
  return missing.map((s) => ({ id: s.id, name: i.sections[s.id], effect: i.sectionMissing[s.id] }));
}

/** Names of the sections no pull could settle yet (Trades or Cash Transactions absent on short windows only). */
export function unknownSectionNames(sections: IbkrSectionItem[], t: Dictionary): string[] {
  return sections.filter((s) => s.state === "unknown").map((s) => t.secrets.ibkr.sections[s.id]);
}

export interface SectionStatusRow {
  id: IbkrSectionId;
  name: string;
  state: IbkrSectionItem["state"];
  /** "In the query", "Missing" or "Not checked yet". */
  label: string;
  /** A missing section: what yomi lacks without it ("yomi misses …"); null otherwise. */
  effect: string | null;
}

/** Every section in reading order with its state label and, when missing, what yomi lacks. */
export function sectionStatusRows(sections: IbkrSectionItem[], t: Dictionary): SectionStatusRow[] {
  const i = t.secrets.ibkr;
  return sections.map((s) => ({
    id: s.id,
    name: i.sections[s.id],
    state: s.state,
    label: i.sectionState[s.state],
    effect: s.state === "missing" ? fmt(i.sectionEffect, { effect: i.sectionMissing[s.id] }) : null,
  }));
}

/** "Flex sections: all 6 in the query", or "Flex sections: 4 of 6 in the query, 1 missing, 1 not checked yet". */
export function sectionsSummary(sections: IbkrSectionItem[], t: Dictionary): string {
  const i = t.secrets.ibkr;
  const count = (state: IbkrSectionItem["state"]) => sections.filter((s) => s.state === state).length;
  const present = count("present");
  const missing = count("missing");
  const unknown = count("unknown");
  const parts =
    present === sections.length
      ? [i.sectionsSummaryAll]
      : [
          fmt(i.sectionsSummaryPresent, { count: present }),
          missing ? fmt(i.sectionsSummaryMissing, { count: missing }) : null,
          unknown ? fmt(i.sectionsSummaryUnknown, { count: unknown }) : null,
        ].filter((x): x is string => x != null);
  return fmt(i.sectionsTitle, { summary: parts.join(i.sectionsSummarySep) });
}
