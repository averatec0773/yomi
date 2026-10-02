import type { IbkrSectionItem } from "@yomi/contracts";
import type { Dictionary } from "@/i18n/en";

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
