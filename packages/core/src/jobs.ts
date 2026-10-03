// The jobs-row protocol every background job shares (bank-sync, holdings-sync and the IBKR history pull): one row
// per user and job name, a compare-and-set claim so two runs never overlap, and a finish that records the outcome
// and when to try again. Idempotent and cursor-based; the job's own cursor format is its business.
import { type Db, jobs } from "@yomi/db";
import { and, eq, lt, ne, or } from "@yomi/db/orm";
import type { CurrentUser } from "./user";

export type JobRow = typeof jobs.$inferSelect;

/** A failed run is retried this long after it ended. */
const RETRY_AFTER_FAILURE_MS = 30 * 60 * 1000;
/** A `running` row older than this is left over from a crashed process and may be taken over. */
const STALE_RUNNING_MS = 30 * 60 * 1000;

/** The job's row, created idle on first use. */
export async function loadJob(db: Db, user: CurrentUser, name: string): Promise<JobRow> {
  await db.insert(jobs).values({ userId: user.id, name, status: "idle" }).onConflictDoNothing();
  return (await db.select().from(jobs).where(and(eq(jobs.userId, user.id), eq(jobs.name, name))).limit(1))[0]!;
}

/**
 * Takes the row for this run: true unless another run holds it. A crashed run's row is taken over once its
 * updated_at is stale; updated_at is written with the real clock, so staleness is judged by it too.
 */
export async function claimJob(db: Db, job: JobRow): Promise<boolean> {
  const staleBefore = new Date(Date.now() - STALE_RUNNING_MS).toISOString();
  const claimed = await db
    .update(jobs)
    .set({ status: "running" })
    .where(and(eq(jobs.id, job.id), or(ne(jobs.status, "running"), lt(jobs.updatedAt, staleBefore))))
    .returning({ id: jobs.id });
  return claimed.length > 0;
}

export interface JobEnd {
  failed: boolean;
  now: Date;
  /** The job's new cursor; left as it was when omitted. */
  cursor?: string;
  lastError: string | null;
  /** After a success: when the next run is due (null or omitted: whenever the job says so). */
  runAfter?: string | null;
}

/** Releases the row after a run: idle with attempts reset, or failed with one more attempt and a retry in 30 minutes. */
export async function finishJob(db: Db, job: JobRow, end: JobEnd): Promise<void> {
  await db
    .update(jobs)
    .set({
      status: end.failed ? "failed" : "idle",
      ...(end.cursor !== undefined && { cursor: end.cursor }),
      attempts: end.failed ? job.attempts + 1 : 0,
      lastError: end.lastError,
      runAfter: end.failed ? new Date(end.now.getTime() + RETRY_AFTER_FAILURE_MS).toISOString() : (end.runAfter ?? null),
    })
    .where(eq(jobs.id, job.id));
}
