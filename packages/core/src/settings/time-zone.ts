import { type Db, transactions } from "@yomi/db";
import { eq } from "@yomi/db/orm";
import { LedgerError } from "../ledger/errors";
import { DEFAULT_TIME_ZONE, isTimeZone, occurredOnFor, todayIn } from "../time/zone";
import type { CurrentUser } from "../user";
import { readSetting, writeSetting } from "./store";

const TIME_ZONE_KEY = "timeZone";
/** The zone transactions.occurred_on was last computed in; differs from timeZone only before a recompute. */
const OCCURRED_ON_ZONE_KEY = "occurredOnZone";

export interface TimeZoneSetting {
  timeZone: string;
  /** False until a zone was stored (the browser posts its own once on first visit). */
  isSet: boolean;
}

export interface TimeZoneChange extends TimeZoneSetting {
  /** Rows whose occurred_on changed. */
  changed: number;
}

export async function getTimeZoneSetting(q: Db, user: CurrentUser): Promise<TimeZoneSetting> {
  const stored = await readSetting(q, user, TIME_ZONE_KEY);
  return stored && isTimeZone(stored) ? { timeZone: stored, isSet: true } : { timeZone: DEFAULT_TIME_ZONE, isSet: false };
}

/** The user's IANA time zone (default America/Chicago). */
export async function getTimeZone(q: Db, user: CurrentUser): Promise<string> {
  return (await getTimeZoneSetting(q, user)).timeZone;
}

/** Today's 'YYYY-MM-DD' in the user's time zone, the day transactions.occurred_on is counted in. */
export async function userToday(q: Db, user: CurrentUser): Promise<string> {
  return todayIn(await getTimeZone(q, user));
}

/** Recomputes occurred_on for every row of the user in `timeZone` (default: the stored zone). Returns rows changed. */
export async function recomputeOccurredOn(db: Db, user: CurrentUser, zone?: string): Promise<number> {
  const timeZone = zone ?? (await getTimeZone(db, user));
  return await db.transaction(async (tx) => {
    const rows = await tx
      .select({ id: transactions.id, occurredAt: transactions.occurredAt, occurredOn: transactions.occurredOn, source: transactions.source })
      .from(transactions)
      .where(eq(transactions.userId, user.id));
    let changed = 0;
    for (const r of rows) {
      const day = occurredOnFor(r.occurredAt, r.source, timeZone);
      if (day === r.occurredOn) continue;
      await tx.update(transactions).set({ occurredOn: day }).where(eq(transactions.id, r.id));
      changed += 1;
    }
    await writeSetting(tx, user, OCCURRED_ON_ZONE_KEY, timeZone);
    return changed;
  });
}

/**
 * Startup catch-up: recomputes occurred_on when it was not computed in the current zone yet (after the
 * migration that added it, or an interrupted change). Returns rows changed, 0 when already current.
 */
export async function ensureOccurredOn(db: Db, user: CurrentUser): Promise<number> {
  const zone = await getTimeZone(db, user);
  if (await readSetting(db, user, OCCURRED_ON_ZONE_KEY) === zone) return 0;
  return await recomputeOccurredOn(db, user, zone);
}

/** Stores the zone and regroups every transaction by it. */
export async function setTimeZone(db: Db, user: CurrentUser, timeZone: string): Promise<TimeZoneChange> {
  const zone = timeZone.trim();
  if (!isTimeZone(zone)) throw new LedgerError("invalid", "invalid_time_zone", `Unknown time zone: ${timeZone}`, { value: timeZone });
  await writeSetting(db, user, TIME_ZONE_KEY, zone);
  const changed = await recomputeOccurredOn(db, user, zone);
  return { timeZone: zone, isSet: true, changed };
}
