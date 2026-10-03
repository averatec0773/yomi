import { accounts, type Db, merchantRules, transactions } from "@yomi/db";
import { eq } from "@yomi/db/orm";
import { describe, expect, it } from "vitest";
import { listTransactions, unsplitSummary } from "../ledger";
import { addParticipant, addSplit, addTx, catId, freshDb, selfId, user } from "../ledger/test-helpers";
import { addDays } from "../time/day";
import { userToday } from "../settings/time-zone";
import {
  acceptSuggestions,
  archiveParticipant,
  dismissSplitSuggestion,
  getSplit,
  revertAcceptedSuggestions,
  setAutoSplit,
  setMerchantSuggest,
  setSplit,
  suggestSplit,
  toggleParticipant,
  unsplitSuggestions,
} from "./index";

const TODAY = "2026-09-29";
const at = (day: string) => `${day}T12:00:00+08:00`;

async function setup() {
  const db = await freshDb();
  const accountId = (await db
    .insert(accounts)
    .values({ userId: user.id, name: "Card 3141", kind: "credit_card", institution: "Demo Bank", currency: "CNY" })
    .returning())[0]!.id;
  const alex = await addParticipant(db, "Alex");
  const sam = await addParticipant(db, "Sam");
  const groceries = await catId(db, "买菜");
  return { db, accountId, alex, sam, groceries };
}

/** A split expense row in the category, no merchant (so no merchant rule is written). */
async function splitRow(db: Db, categoryId: number, ids: number[], day = "2026-09-01", accountId = 1) {
  const id = await addTx(db, { amountMinor: -3000, categoryId, merchant: "", accountId, occurredAt: at(day) });
  await setSplit(db, user, id, { participantIds: ids, mode: "equal" });
  return id;
}

async function target(db: Db, categoryId: number | null, merchant = "New Market", day = "2026-09-20") {
  return await addTx(db, { amountMinor: -4200, categoryId, merchant, accountId: 1, occurredAt: at(day) });
}

describe("suggestSplit: category learning", () => {
  it("suggests the set used on at least 80% of at least 5 recent split rows", async () => {
    const { db, alex, sam, groceries } = await setup();
    for (let i = 0; i < 4; i++) await splitRow(db, groceries, [alex]);
    await splitRow(db, groceries, [alex, sam]);
    const t = await target(db, groceries);
    expect(await suggestSplit(db, user, t, { today: TODAY })).toEqual({
      participantIds: [alex],
      source: "category",
      confidence: 0.8,
      reason: { code: "suggest_category_share", params: { category: "买菜", percent: 80, count: 5 } },
    });
  });

  it("needs at least 5 rows", async () => {
    const { db, alex, groceries } = await setup();
    for (let i = 0; i < 4; i++) await splitRow(db, groceries, [alex]);
    expect((await suggestSplit(db, user, await target(db, groceries), { today: TODAY })).source).toBe("none");
  });

  it("needs an 80% share, and floors the percent it reports", async () => {
    const { db, alex, sam, groceries } = await setup();
    for (let i = 0; i < 3; i++) await splitRow(db, groceries, [alex]);
    for (let i = 0; i < 2; i++) await splitRow(db, groceries, [sam]);
    const t = await target(db, groceries);
    expect((await suggestSplit(db, user, t, { today: TODAY })).source).toBe("none");
  });

  it("needs splitting to be usual for the category: split rows at least a third of its expense rows", async () => {
    const { db, alex, groceries } = await setup();
    for (let i = 0; i < 5; i++) await splitRow(db, groceries, [alex]);
    const t = await target(db, groceries);
    // 5 split of 15 rows (the target included) is exactly a third.
    for (let i = 0; i < 9; i++) await target(db, groceries, `Shop ${i}`);
    expect((await suggestSplit(db, user, t, { today: TODAY })).source).toBe("category");
    await target(db, groceries, "One more");
    expect((await suggestSplit(db, user, t, { today: TODAY })).source).toBe("none");
  });

  it("reports the floored share", async () => {
    const { db, alex, sam, groceries } = await setup();
    for (let i = 0; i < 8; i++) await splitRow(db, groceries, [alex]);
    await splitRow(db, groceries, [sam]);
    const s = await suggestSplit(db, user, await target(db, groceries), { today: TODAY });
    expect(s.reason).toEqual({ code: "suggest_category_share", params: { category: "买菜", percent: 88, count: 9 } });
    expect(s.confidence).toBeCloseTo(8 / 9);
  });

  it("only counts the last 180 days, rows I paid, and sets of active people", async () => {
    const { db, alex, groceries } = await setup();
    for (let i = 0; i < 5; i++) await splitRow(db, groceries, [alex], addDays(TODAY, -181));
    const t = await target(db, groceries);
    expect((await suggestSplit(db, user, t, { today: TODAY })).source).toBe("none");
    expect((await suggestSplit(db, user, t, { today: addDays(TODAY, -2) })).source).toBe("category");

    // Friend-paid rows (Sam paid) are not "who shares groceries" evidence.
    const db2 = await setup();
    for (let i = 0; i < 5; i++) {
      const id = await addTx(db2.db, { amountMinor: -3000, categoryId: db2.groceries, merchant: "", accountId: null, occurredAt: at("2026-09-02") });
      await addSplit(db2.db, id, await selfId(db2.db), 1500);
      await addSplit(db2.db, id, db2.sam, 1500, 3000);
    }
    expect((await suggestSplit(db2.db, user, await target(db2.db, db2.groceries), { today: TODAY })).source).toBe("none");

    // An archived person's set is not suggested.
    const recent = await setup();
    for (let i = 0; i < 5; i++) await splitRow(recent.db, recent.groceries, [recent.sam]);
    await archiveParticipant(recent.db, user, recent.sam, true);
    expect((await suggestSplit(recent.db, user, await target(recent.db, recent.groceries), { today: TODAY })).source).toBe("none");
  });

  it("never suggests for split, closed, duplicate or non-expense rows", async () => {
    const { db, alex, groceries } = await setup();
    for (let i = 0; i < 5; i++) await splitRow(db, groceries, [alex]);
    const closed = await addTx(db, { amountMinor: -100, categoryId: groceries, status: "closed", accountId: 1 });
    const income = await addTx(db, { amountMinor: 100, categoryId: groceries, accountId: 1 });
    const split = await splitRow(db, groceries, [alex]);
    for (const id of [closed, income, split]) expect((await suggestSplit(db, user, id, { today: TODAY })).source).toBe("none");
  });
});

describe("suggestSplit: merchant rule precedence", () => {
  it("a merchant rule wins over the category, with the length of its recent run", async () => {
    const { db, alex, sam, groceries } = await setup();
    for (let i = 0; i < 5; i++) await splitRow(db, groceries, [alex]);
    const old = await addTx(db, { amountMinor: -500, categoryId: groceries, merchant: "Corner Shop", accountId: 1, occurredAt: at("2026-08-01") });
    await toggleParticipant(db, user, old, alex);
    for (const day of ["2026-09-01", "2026-09-05", "2026-09-09"]) {
      await toggleParticipant(db, user, await addTx(db, { amountMinor: -500, categoryId: groceries, merchant: "Corner Shop", accountId: 1, occurredAt: at(day) }), sam);
    }
    const t = await target(db, groceries, "Corner Shop");
    const s = await suggestSplit(db, user, t, { today: TODAY });
    expect(s).toEqual({
      participantIds: [sam],
      source: "merchant",
      confidence: 0.75,
      reason: { code: "suggest_merchant_recent", params: { merchant: "Corner Shop", count: 3 } },
    });
  });

  it("a remembered merchant with no matching split on record still suggests", async () => {
    const { db, alex } = await setup();
    await db.insert(merchantRules).values({ userId: user.id, merchant: "Pho Place", participantIds: [alex] });
    expect(await suggestSplit(db, user, await target(db, null, "Pho Place"), { today: TODAY })).toMatchObject({
      participantIds: [alex],
      source: "merchant",
      confidence: 1,
      reason: { code: "suggest_merchant_before", params: { merchant: "Pho Place" } },
    });
  });
});

describe("dismissals", () => {
  it("'not this one' hides the row's suggestion until undone", async () => {
    const { db, alex, groceries } = await setup();
    for (let i = 0; i < 5; i++) await splitRow(db, groceries, [alex]);
    const t = await target(db, groceries);
    const other = await target(db, groceries, "Other Market");
    await dismissSplitSuggestion(db, user, t, true);
    expect((await suggestSplit(db, user, t, { today: TODAY })).source).toBe("none");
    expect((await suggestSplit(db, user, other, { today: TODAY })).source).toBe("category");
    expect((await unsplitSuggestions(db, user, { today: TODAY })).map((s) => s.transactionId)).not.toContain(t);
    await dismissSplitSuggestion(db, user, t, false);
    expect((await suggestSplit(db, user, t, { today: TODAY })).source).toBe("category");
  });

  it("'don't suggest for this merchant' writes a negative rule that also mutes the category; undo restores the people", async () => {
    const { db, alex, sam, groceries } = await setup();
    for (let i = 0; i < 5; i++) await splitRow(db, groceries, [alex]);
    await toggleParticipant(db, user, await addTx(db, { amountMinor: -500, categoryId: groceries, merchant: "Corner Shop", accountId: 1 }), sam);
    const t = await target(db, groceries, "Corner Shop");
    const fresh = await target(db, groceries, "Never Seen");

    const res = await setMerchantSuggest(db, user, "Corner Shop", { suggest: false });
    expect(res).toEqual({ merchant: "Corner Shop", suggest: false, previousParticipantIds: [sam] });
    const rule = (await db.select().from(merchantRules).where(eq(merchantRules.merchant, "Corner Shop")).limit(1))[0]!;
    expect(rule).toMatchObject({ suggest: false, participantIds: null });
    expect((await suggestSplit(db, user, t, { today: TODAY })).source).toBe("none");
    expect((await unsplitSuggestions(db, user, { today: TODAY })).map((s) => s.transactionId)).not.toContain(t);

    // A merchant with no rule yet gets a negative one.
    await setMerchantSuggest(db, user, "Never Seen", { suggest: false });
    expect((await suggestSplit(db, user, fresh, { today: TODAY })).source).toBe("none");

    await setMerchantSuggest(db, user, "Corner Shop", { suggest: true, participantIds: res.previousParticipantIds });
    expect(await suggestSplit(db, user, t, { today: TODAY })).toMatchObject({ source: "merchant", participantIds: [sam] });
  });

  it("an auto-split rule keeps its people when muted, so import auto-split is unchanged", async () => {
    const { db, alex } = await setup();
    await setAutoSplit(db, user, "Rent Co", { participantIds: [alex], enabled: true });
    await setMerchantSuggest(db, user, "Rent Co", { suggest: false });
    expect((await db.select().from(merchantRules).where(eq(merchantRules.merchant, "Rent Co")).limit(1))[0]).toMatchObject({
      autoSplit: true,
      suggest: false,
      participantIds: [alex],
    });
  });
});

describe("acceptSuggestions + undo", () => {
  it("splits every row that has a suggestion equally, skips the rest, and undo clears them", async () => {
    const { db, alex, sam, groceries } = await setup();
    for (let i = 0; i < 5; i++) await splitRow(db, groceries, [alex]);
    await toggleParticipant(db, user, await addTx(db, { amountMinor: -500, merchant: "Corner Shop", accountId: 1 }), sam);
    const byCategory = await target(db, groceries);
    const byMerchant = await target(db, null, "Corner Shop");
    const none = await target(db, null, "Nobody");
    const rulesBefore = await db.select().from(merchantRules);

    const res = await acceptSuggestions(db, user, [byCategory, byMerchant, none, byCategory], { today: TODAY });
    expect(res.accepted).toEqual([
      { transactionId: byCategory, participantIds: [alex] },
      { transactionId: byMerchant, participantIds: [sam] },
    ]);
    expect(res.skipped.map((s) => [s.transactionId, s.code])).toEqual([[none, "no_split_suggestion"]]);
    expect(await getSplit(db, user, byCategory)).toMatchObject({ mode: "equal", participantIds: [alex], myShareMinor: 2100 });
    expect(await getSplit(db, user, byMerchant)).toMatchObject({ mode: "equal", participantIds: [sam] });
    // Accepting does not teach merchant rules, so the undo below leaves no trace in them.
    expect(await db.select().from(merchantRules)).toEqual(rulesBefore);
    const edited = (await db.select({ e: transactions.userEditedAt }).from(transactions).where(eq(transactions.id, byCategory)).limit(1))[0]!.e;
    expect(edited).not.toBeNull();

    expect(await revertAcceptedSuggestions(db, user, [byCategory, byMerchant])).toEqual({ reverted: [byCategory, byMerchant] });
    expect(await getSplit(db, user, byCategory)).toBeNull();
    expect(await getSplit(db, user, byMerchant)).toBeNull();
    expect((await suggestSplit(db, user, byMerchant, { today: TODAY })).source).toBe("merchant");
  });
});

describe("suggestions in lists", () => {
  it("listTransactions and unsplitSummary carry category suggestions", async () => {
    const { db, alex, groceries } = await setup();
    const today = await userToday(db, user);
    for (let i = 0; i < 5; i++) await splitRow(db, groceries, [alex], addDays(today, -10));
    const t = await target(db, groceries, "New Market", addDays(today, -1));
    const item = (await listTransactions(db, user, { id: t })).items[0]!;
    expect(item.suggestedParticipantIds).toEqual([alex]);
    expect(item.suggestion).toMatchObject({ source: "category", participantIds: [alex] });
    expect((await unsplitSummary(db, user)).reduce((n, m) => n + m.suggestedCount, 0)).toBe(1);
    await dismissSplitSuggestion(db, user, t, true);
    expect((await listTransactions(db, user, { id: t })).items[0]!.suggestion).toBeNull();
    expect((await unsplitSummary(db, user)).reduce((n, m) => n + m.suggestedCount, 0)).toBe(0);
  });
});
