import { categories, participants } from "@yomi/db";
import { asc, eq } from "@yomi/db/orm";
import { testDb } from "@yomi/db/testing";
import { describe, expect, it } from "vitest";
import { seed, SYSTEM_EXPENSE_CATEGORIES, SYSTEM_INCOME_CATEGORIES } from "./seed";
import { getCurrentUser } from "./user";

const freshDb = testDb;

describe("seed", () => {
  it("inserts the self participant and all system categories", async () => {
    const db = await freshDb();
    await seed(db);
    const ps = await db.select().from(participants);
    expect(ps).toHaveLength(1);
    expect(ps[0]).toMatchObject({ name: "我", isSelf: true, userId: 1 });
    const cats = await db.select().from(categories).orderBy(asc(categories.id));
    expect(cats.filter((c) => c.kind === "expense").map((c) => [c.key, c.name])).toEqual(SYSTEM_EXPENSE_CATEGORIES.map((c) => [c.key, c.name]));
    expect(cats.filter((c) => c.kind === "income").map((c) => [c.key, c.name])).toEqual(SYSTEM_INCOME_CATEGORIES.map((c) => [c.key, c.name]));
    expect(cats.every((c) => c.isSystem && c.userId === 1 && c.archivedAt === null)).toBe(true);
    expect(cats.filter((c) => !c.countsAsIncome).map((c) => c.key)).toEqual(["reimbursement"]);
  });

  it("is idempotent", async () => {
    const db = await freshDb();
    await seed(db);
    await seed(db);
    await seed(db);
    expect(await db.select().from(participants)).toHaveLength(1);
    expect(await db.select().from(categories)).toHaveLength(
      SYSTEM_EXPENSE_CATEGORIES.length + SYSTEM_INCOME_CATEGORIES.length,
    );
    expect(await db.select().from(participants).where(eq(participants.isSelf, true))).toHaveLength(1);
  });
});

describe("getCurrentUser", () => {
  it("returns user 1 in local mode (default)", () => {
    const prev = process.env.LOCAL_MODE;
    delete process.env.LOCAL_MODE;
    try {
      expect(getCurrentUser()).toEqual({ id: 1 });
      process.env.LOCAL_MODE = "true";
      expect(getCurrentUser()).toEqual({ id: 1 });
      process.env.LOCAL_MODE = "false";
      expect(() => getCurrentUser()).toThrow();
    } finally {
      if (prev === undefined) delete process.env.LOCAL_MODE;
      else process.env.LOCAL_MODE = prev;
    }
  });
});
