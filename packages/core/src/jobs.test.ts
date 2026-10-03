import { jobs } from "@yomi/db";
import { testDb } from "@yomi/db/testing";
import { eq } from "@yomi/db/orm";
import { describe, expect, it } from "vitest";
import { claimJob, finishJob, loadJob } from "./jobs";
import { getCurrentUser } from "./user";

const user = getCurrentUser();

describe("job row protocol", () => {
  it("one row per job, one run at a time, a crashed run taken over once stale", async () => {
    const db = await testDb();
    const job = await loadJob(db, user, "demo");
    expect((await loadJob(db, user, "demo")).id).toBe(job.id);
    expect(await claimJob(db, job)).toBe(true);
    expect(await claimJob(db, job)).toBe(false);
    await db.update(jobs).set({ updatedAt: new Date(Date.now() - 31 * 60 * 1000).toISOString() }).where(eq(jobs.id, job.id));
    expect(await claimJob(db, job)).toBe(true);
  });

  it("a failure counts an attempt and retries in 30 minutes; a success resets both", async () => {
    const db = await testDb();
    const job = await loadJob(db, user, "demo");
    const now = new Date("2026-10-02T12:00:00.000Z");
    await finishJob(db, job, { failed: true, now, lastError: "boom" });
    const failed = await loadJob(db, user, "demo");
    expect(failed).toMatchObject({ status: "failed", attempts: 1, lastError: "boom", runAfter: "2026-10-02T12:30:00.000Z" });
    await finishJob(db, failed, { failed: false, now, cursor: "c1", lastError: null, runAfter: "2026-10-02T18:00:00.000Z" });
    expect(await loadJob(db, user, "demo")).toMatchObject({ status: "idle", attempts: 0, lastError: null, cursor: "c1", runAfter: "2026-10-02T18:00:00.000Z" });
  });
});
