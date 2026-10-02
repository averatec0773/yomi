import type { IbkrTestResult } from "@yomi/contracts";
import type { Dictionary } from "@/i18n/en";

export type IbkrSectionId = IbkrTestResult["sections"][number]["id"];

/**
 * What a test statement says about the query's sections: null when every section yomi reads is there, else
 * each missing one with its name and what yomi will lack without it, in the order yomi reads them.
 */
export function missingSectionNotes(sections: IbkrTestResult["sections"], t: Dictionary): { id: IbkrSectionId; name: string; effect: string }[] | null {
  const i = t.secrets.ibkr;
  const missing = sections.filter((s) => !s.present);
  if (missing.length === 0) return null;
  return missing.map((s) => ({ id: s.id, name: i.sections[s.id], effect: i.sectionMissing[s.id] }));
}
