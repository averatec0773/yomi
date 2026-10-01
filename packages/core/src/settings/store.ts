import { userSettings, type Db } from "@yomi/db";
import { and, eq } from "@yomi/db/orm";
import type { CurrentUser } from "../user";

/** A database or a transaction. */
export type Q = Db;

/** One user_settings value, or null when not stored. */
export async function readSetting(q: Q, user: CurrentUser, key: string): Promise<string | null> {
  return (
    (await q
      .select({ value: userSettings.value })
      .from(userSettings)
      .where(and(eq(userSettings.userId, user.id), eq(userSettings.key, key)))
      .limit(1))[0]?.value ?? null
  );
}

export async function writeSetting(q: Q, user: CurrentUser, key: string, value: string): Promise<void> {
  await q.insert(userSettings)
    .values({ userId: user.id, key, value })
    .onConflictDoUpdate({ target: [userSettings.userId, userSettings.key], set: { value, updatedAt: new Date().toISOString() } });
}

export async function deleteSetting(q: Q, user: CurrentUser, key: string): Promise<void> {
  await q.delete(userSettings)
    .where(and(eq(userSettings.userId, user.id), eq(userSettings.key, key)));
}
