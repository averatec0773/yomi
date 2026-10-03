import { createHash } from "node:crypto";
import { FLEX_SECTION_IDS, type FlexSectionId } from "@yomi/importers";
import type { Db } from "@yomi/db";
import { readSetting, writeSetting } from "../settings/store";
import { daysInclusive } from "../time/day";
import type { CurrentUser } from "../user";

/** user_settings key (plain JSON, no secret): which Flex sections the IBKR pulls had, see `IbkrSectionsRecord`. */
export const IBKR_SECTIONS_SETTING = "ibkr_flex_sections";

/** Sections IBKR may leave out of a statement whose window had no such activity. */
export const IBKR_ACTIVITY_SECTIONS: readonly FlexSectionId[] = ["trades", "cashTransactions"];
/** A window at least this long that lacks an activity section counts as the query lacking it. */
export const IBKR_ACTIVITY_WINDOW_DAYS = 30;

/** `unknown`: an activity section seen only on short windows without activity, so absence proves nothing. */
export type IbkrSectionState = "present" | "missing" | "unknown";

export interface IbkrSectionItem {
  id: FlexSectionId;
  state: IbkrSectionState;
}

/** One pull of the query: its window (both days inclusive) and the sections its statement had. */
export interface IbkrPullSections {
  /** When the pull happened (ISO time). */
  at: string;
  from: string;
  to: string;
  present: readonly string[];
  /** `ibkrQueryKey` of the query pulled; null when unknown (an injected source). */
  query: string | null;
}

/** What the latest pulls of one query say about its sections. */
export interface IbkrSectionsRecord {
  v: 1;
  query: string | null;
  /** The latest pull. */
  at: string;
  from: string;
  to: string;
  sections: IbkrSectionItem[];
}

/** A short fingerprint of the query id, so a record of another query is never shown (the id itself is not stored here). */
export function ibkrQueryKey(queryId: string): string {
  return createHash("sha256").update(`yomi-ibkr-query:${queryId.trim()}`).digest("hex").slice(0, 16);
}

/**
 * The record after one more pull. Account Information, Open Positions, Cash Report and NAV in Base appear on every
 * statement of a query that has them (empty ones included), so the latest pull decides. Trades and Cash Transactions
 * are left out on a window without activity: seen on any pull means present; lacking on a window of at least 30
 * days means missing; lacking on a shorter window keeps the earlier verdict (unknown when there is none). A record
 * of another query starts over.
 */
export function nextSectionsRecord(prev: IbkrSectionsRecord | null, pull: IbkrPullSections): IbkrSectionsRecord {
  const base = prev && prev.query === pull.query ? prev : null;
  const had = new Set(pull.present);
  const long = daysInclusive(pull.from, pull.to) >= IBKR_ACTIVITY_WINDOW_DAYS;
  const sections = FLEX_SECTION_IDS.map((id): IbkrSectionItem => {
    if (had.has(id)) return { id, state: "present" };
    if (!IBKR_ACTIVITY_SECTIONS.includes(id) || long) return { id, state: "missing" };
    return { id, state: base?.sections.find((s) => s.id === id)?.state ?? "unknown" };
  });
  return { v: 1, query: pull.query, at: pull.at, from: pull.from, to: pull.to, sections };
}

export function parseSectionsRecord(raw: string | null): IbkrSectionsRecord | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as IbkrSectionsRecord;
    if (v?.v !== 1 || !Array.isArray(v.sections)) return null;
    // Sections yomi did not read when the record was written are unknown.
    const by = new Map(v.sections.map((s) => [s.id, s.state]));
    return { ...v, sections: FLEX_SECTION_IDS.map((id) => ({ id, state: by.get(id) ?? "unknown" })) };
  } catch {
    return null;
  }
}

/** Records one successful pull of the IBKR query (scheduled, Sync now, Pull history or Test connection on the saved query). */
export async function recordIbkrSections(q: Db, user: CurrentUser, pull: IbkrPullSections): Promise<IbkrSectionsRecord> {
  const next = nextSectionsRecord(parseSectionsRecord(await readSetting(q, user, IBKR_SECTIONS_SETTING)), pull);
  await writeSetting(q, user, IBKR_SECTIONS_SETTING, JSON.stringify(next));
  return next;
}

/** The recorded sections of the query `queryKey`, or null when its pulls recorded nothing yet. */
export async function ibkrSectionsRecord(db: Db, user: CurrentUser, queryKey: string | null): Promise<IbkrSectionsRecord | null> {
  const r = parseSectionsRecord(await readSetting(db, user, IBKR_SECTIONS_SETTING));
  return r && (r.query == null || r.query === queryKey) ? r : null;
}
