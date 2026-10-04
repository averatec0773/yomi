import { type Db, participants } from "@yomi/db";
import { type IncomeUpgradeResult, upgradeIncomeTaxonomy } from "./ledger/income-taxonomy";
import { ensureSystemCategories } from "./ledger/system-categories";
import { getCurrentUser } from "./user";

export { LEGACY_INCOME_CATEGORIES, SYSTEM_EXPENSE_CATEGORIES, SYSTEM_INCOME_CATEGORIES, type SystemCategory } from "./ledger/system-categories";

export const SELF_PARTICIPANT_NAME = "我";

/**
 * Inserts the self participant and system categories for the current user, then runs the one-time income upgrade of
 * existing rows (its counts, or null when it ran before). Safe to run repeatedly.
 */
export async function seed(db: Db): Promise<IncomeUpgradeResult | null> {
  const user = getCurrentUser();
  await db.transaction(async (tx) => {
    await tx.insert(participants)
      .values({ userId: user.id, name: SELF_PARTICIPANT_NAME, isSelf: true })
      .onConflictDoNothing();
    await ensureSystemCategories(tx, user.id);
  });
  return await upgradeIncomeTaxonomy(db, user);
}
