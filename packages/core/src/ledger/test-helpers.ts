import { categories, type Db, participants, transactions, transactionSplits } from "@yomi/db";
import { testDb } from "@yomi/db/testing";
import { and, eq } from "@yomi/db/orm";
import { seed } from "../seed";
import { getTimeZone, setTimeZone } from "../settings/time-zone";
import { occurredOnFor } from "../time/zone";
import { getCurrentUser } from "../user";

export const user = getCurrentUser();

/**
 * The test file's shared in-memory database, emptied and seeded (see @yomi/db/testing testDb): calling it again
 * empties it again, so a test needing two databases at once takes the second from isolatedTestDb.
 */
export async function freshDb(): Promise<Db> {
  const db = await testDb();
  await seed(db);
  // Fixtures are Beijing-time (+08:00) rows; in this zone their days are their stated dates.
  await setTimeZone(db, user, "Asia/Shanghai");
  return db;
}

export async function catId(db: Db, name: string): Promise<number> {
  return (await db
    .select()
    .from(categories)
    .where(and(eq(categories.userId, user.id), eq(categories.name, name)))
    .limit(1))[0]!.id;
}

export async function selfId(db: Db): Promise<number> {
  return (await db
    .select()
    .from(participants)
    .where(and(eq(participants.userId, user.id), eq(participants.isSelf, true)))
    .limit(1))[0]!.id;
}

export async function addParticipant(db: Db, name: string): Promise<number> {
  return (await db.insert(participants).values({ userId: user.id, name }).returning())[0]!.id;
}

let n = 0;
export async function addTx(db: Db, p: Partial<typeof transactions.$inferInsert> & { amountMinor: number }): Promise<number> {
  n += 1;
  const occurredAt = p.occurredAt ?? "2026-09-10T12:00:00+08:00";
  const source = p.source ?? "alipay";
  return (await db
    .insert(transactions)
    .values({
      userId: user.id,
      occurredAt,
      occurredOn: occurredOnFor(occurredAt, source, await getTimeZone(db, user)),
      currency: "CNY",
      kind: p.amountMinor < 0 ? "expense" : "income",
      source,
      dedupKey: `t:${n}`,
      ...p,
    })
    .returning()
    )[0]!.id;
}

export async function addSplit(db: Db, transactionId: number, participantId: number, owedMinor: number, paidMinor = 0, currency = "CNY") {
  await db.insert(transactionSplits)
    .values({ userId: user.id, transactionId, participantId, currency, owedMinor, paidMinor, method: "exact" });
}
