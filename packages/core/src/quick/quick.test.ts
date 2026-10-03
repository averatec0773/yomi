import { accounts, categories, transactions } from "@yomi/db";
import { testDb } from "@yomi/db/testing";
import { eq } from "@yomi/db/orm";
import { describe, expect, it } from "vitest";
import { seed } from "../seed";
import { balances, createParticipant, listParticipants } from "../split";
import { getCurrentUser } from "../user";
import { createQuickEntry } from "./create";
import { quickDraft } from "./draft";
import { parseQuickEntry, type QuickParseContext } from "./parse";

const ctx: QuickParseContext = {
  today: "2026-09-29", // a Tuesday
  defaultCurrency: "CNY",
  participants: [
    { id: 1, name: "我", isSelf: true },
    { id: 2, name: "室友", aliases: ["小王"] },
    { id: 3, name: "小李" },
    { id: 4, name: "Wang" },
  ],
};
const p = (text: string, over: Partial<QuickParseContext> = {}) => parseQuickEntry(text, { ...ctx, ...over });

describe("parseQuickEntry: amounts and currency", () => {
  it.each([
    ["35 午饭", 3500, "CNY"],
    ["午饭 35.5", 3550, "CNY"],
    ["¥35 午饭", 3500, "CNY"],
    ["￥35 午饭", 3500, "CNY"],
    ["$12.50 lunch", 1250, "USD"],
    ["lunch 12.5usd", 1250, "USD"],
    ["lunch 12.5 USD", 1250, "USD"],
    ["12.5刀 外卖", 1250, "USD"],
    ["35元 打车", 3500, "CNY"],
    ["35块 打车", 3500, "CNY"],
    ["35块钱 打车", 3500, "CNY"],
    ["20rmb 奶茶", 2000, "CNY"],
    ["３５ 午饭", 3500, "CNY"],
  ])("%s → %i %s", (text, amount, currency) => {
    const d = p(text);
    expect(d.amountMinor).toBe(amount);
    expect(d.currency).toBe(currency);
    expect(d.errors).toEqual([]);
  });

  it("uses the default currency without a marker", () => {
    expect(p("coffee 4.5", { defaultCurrency: "USD" })).toMatchObject({ amountMinor: 450, currency: "USD", description: "coffee" });
  });

  it("skips quantities and reports a missing amount", () => {
    expect(p("西瓜 2个 15")).toMatchObject({ amountMinor: 1500, description: "西瓜 2个" });
    expect(p("午饭").errors.map((e) => e.code)).toEqual(["quick_missing_amount"]);
    expect(p("午饭 0").errors.map((e) => e.code)).toEqual(["quick_amount_not_positive"]);
    expect(p("午饭 1.234").errors).toEqual([{ code: "quick_invalid_amount", message: "Invalid amount: 1.234", params: { value: "1.234" } }]);
  });
});

describe("parseQuickEntry: dates", () => {
  it.each([
    ["今天 午饭 35", "2026-09-29"],
    ["昨天 午饭 35", "2026-09-28"],
    ["前天 午饭 35", "2026-09-27"],
    ["9-28 午饭 35", "2026-09-28"],
    ["9/28 午饭 35", "2026-09-28"],
    ["2026-09-01 午饭 35", "2026-09-01"],
    ["9月5日 午饭 35", "2026-09-05"],
    ["12-30 午饭 35", "2025-12-30"],
    ["周一 午饭 35", "2026-09-28"],
    ["周日 午饭 35", "2026-09-27"],
    ["周二 午饭 35", "2026-09-22"],
    ["星期三 午饭 35", "2026-09-23"],
  ])("%s → %s", (text, date) => {
    const d = p(text);
    expect(d.date).toBe(date);
    expect(d.amountMinor).toBe(3500);
    expect(d.description).toBe("午饭");
  });

  it("defaults to today and reports impossible dates", () => {
    expect(p("午饭 35").date).toBe("2026-09-29");
    expect(p("2-30 午饭 35").errors).toEqual([{ code: "quick_invalid_date", message: "Invalid date: 2-30", params: { value: "2-30" } }]);
  });
});

describe("parseQuickEntry: participants, payer, mode", () => {
  it("@name selects participants (name, alias, fuzzy prefix)", () => {
    expect(p("盒马 120 @室友")).toMatchObject({ participantIds: [2], payerId: null, mode: "equal", description: "盒马" });
    expect(p("@小王 @小李 火锅 300")).toMatchObject({ participantIds: [2, 3], description: "火锅" });
    expect(p("dinner 60 @wa")).toMatchObject({ participantIds: [4], description: "dinner" });
    expect(p("@室友吃饭 80")).toMatchObject({ participantIds: [2], description: "吃饭" });
  });

  it("bare participant names count too", () => {
    expect(p("和室友吃火锅 200")).toMatchObject({ participantIds: [2], description: "吃火锅" });
    expect(p("dinner with Wang 45")).toMatchObject({ participantIds: [4], description: "dinner" });
  });

  it("unknown @name is reported so the UI can offer to create it", () => {
    const d = p("@老张 烧烤 90");
    expect(d.participantIds).toEqual([]);
    expect(d.errors).toEqual([{ code: "quick_unknown_participant", message: "Unknown participant: 老张", params: { name: "老张" }, name: "老张" }]);
    expect(d.description).toBe("烧烤");
  });

  it("「X 请」 is a treat, not a split: rejected with a hint", () => {
    const d = p("晚饭 120 小王 请");
    expect(d.payerId).toBeNull();
    expect(d.errors).toContainEqual(expect.objectContaining({ code: "quick_treat", params: { name: "室友" } }));
  });

  it("payer forms: @X 付 / X付了", () => {
    expect(p("@室友 付 80 电费")).toMatchObject({ payerId: 2, participantIds: [2], amountMinor: 8000, description: "电费", mode: "equal" });
    expect(p("小李付了 45 外卖")).toMatchObject({ payerId: 3, participantIds: [3], description: "外卖" });
    expect(p("@室友付80电费")).toMatchObject({ payerId: 2, amountMinor: 8000, description: "电费" });
    expect(p("@室友 付 90 @小李 水费")).toMatchObject({ payerId: 2, participantIds: [2, 3] });
  });

  it("full mode: 全给@X / 帮@X / 帮X", () => {
    expect(p("全给@室友 快递 12")).toMatchObject({ mode: "full", participantIds: [2], payerId: null, description: "快递" });
    expect(p("帮@小李 带饭 25元")).toMatchObject({ mode: "full", participantIds: [3], description: "带饭" });
    expect(p("帮小李买药 30")).toMatchObject({ mode: "full", participantIds: [3], description: "买药" });
  });

  it("category hints from the description", () => {
    expect(p("@室友 付 80 电费").categoryHint).toBe("居住");
    expect(p("盒马 买菜 120").categoryHint).toBe("买菜");
    expect(p("川菜馆吃饭 88").categoryHint).toBe("餐饮");
    expect(p("打车 35").categoryHint).toBe("交通");
    expect(p("随便 35").categoryHint).toBeNull();
  });
});

describe("parseQuickEntry: English grammar", () => {
  const en: QuickParseContext = {
    today: "2026-09-29", // a Tuesday
    defaultCurrency: "USD",
    participants: [
      { id: 1, name: "我", isSelf: true },
      { id: 2, name: "roommate" },
      { id: 3, name: "Alex" },
      { id: 4, name: "Bo" },
    ],
  };
  const e = (text: string) => parseQuickEntry(text, en);

  it.each([
    ["today lunch 35", "2026-09-29"],
    ["yesterday lunch 35", "2026-09-28"],
    ["Yesterday lunch 35", "2026-09-28"],
    ["mon lunch 35", "2026-09-28"],
    ["monday lunch 35", "2026-09-28"],
    ["sun lunch 35", "2026-09-27"],
    ["last friday lunch 35", "2026-09-25"],
    ["on Wed lunch 35", "2026-09-23"],
    ["tue lunch 35", "2026-09-22"],
    ["thurs lunch 35", "2026-09-24"],
    ["saturday lunch 35", "2026-09-26"],
    ["9/28 lunch 35", "2026-09-28"],
  ])("date: %s → %s", (text, date) => {
    expect(e(text)).toMatchObject({ date, amountMinor: 3500, description: "lunch", errors: [] });
  });

  it.each([
    ["lunch 12 usd", 1200, "USD"],
    ["lunch 12 dollars", 1200, "USD"],
    ["lunch 1 dollar", 100, "USD"],
    ["lunch $12", 1200, "USD"],
    ["lunch 12 bucks", 1200, "USD"],
    ["lunch 35 rmb", 3500, "CNY"],
    ["lunch 35 yuan", 3500, "CNY"],
    ["lunch ¥35", 3500, "CNY"],
  ])("currency: %s → %i %s", (text, amount, currency) => {
    expect(e(text)).toMatchObject({ amountMinor: amount, currency, description: "lunch", errors: [] });
  });

  it("the quick-add examples", () => {
    expect(e("lunch 35 @roommate")).toMatchObject({ amountMinor: 3500, participantIds: [2], payerId: null, mode: "equal", description: "lunch" });
    expect(e("yesterday groceries 120 @Alex @Bo")).toMatchObject({
      date: "2026-09-28",
      amountMinor: 12000,
      participantIds: [3, 4],
      description: "groceries",
      categoryHint: "买菜",
    });
    expect(e("@roommate paid 80 utilities")).toMatchObject({
      payerId: 2,
      participantIds: [2],
      amountMinor: 8000,
      description: "utilities",
      categoryHint: "居住",
      errors: [],
    });
  });

  it("payer: X paid", () => {
    expect(e("Alex paid 45 takeout")).toMatchObject({ payerId: 3, participantIds: [3], description: "takeout" });
    expect(e("takeout 45 @Alex paid")).toMatchObject({ payerId: 3, description: "takeout" });
  });

  it("treats: X treated / X's treat are rejected like 「X 请」", () => {
    for (const text of ["dinner 120 Alex treated", "dinner 120 Alex's treat", "dinner 120 @Alex treated"]) {
      const d = e(text);
      expect(d.payerId).toBeNull();
      expect(d.errors).toContainEqual(expect.objectContaining({ code: "quick_treat", params: { name: "Alex" } }));
    }
  });

  it("full mode: all @X / for @X / for X", () => {
    expect(e("all @roommate delivery 12")).toMatchObject({ mode: "full", participantIds: [2], payerId: null, description: "delivery" });
    expect(e("for @Alex medicine 30")).toMatchObject({ mode: "full", participantIds: [3], description: "medicine" });
    expect(e("medicine for Alex 30")).toMatchObject({ mode: "full", participantIds: [3], description: "medicine" });
  });
});

describe("createQuickEntry", () => {
  async function freshDb() {
    const db = await testDb();
    await seed(db);
    return db;
  }
  const user = getCurrentUser();

  it("quickDraft matches identities as aliases, except a Zelle e-mail or phone, and defaults to CNY", async () => {
    const db = await freshDb();
    const roommate = await createParticipant(db, user, "室友", [
      { kind: "wechat", value: "阿王" },
      { kind: "zelle_email", value: "wang@example.com" },
    ]);
    expect(await quickDraft(db, user, { text: "@阿王 80 电费", today: "2026-09-29" })).toMatchObject({
      participantIds: [roommate.id],
      currency: "CNY",
      date: "2026-09-29",
    });
    expect((await quickDraft(db, user, { text: "@wang@example.com 80 电费", today: "2026-09-29" })).participantIds).toEqual([]);
  });

  it("I paid: manual expense on the auto-created 手动记账 account, with splits", async () => {
    const db = await freshDb();
    const roommate = await createParticipant(db, user, "室友");
    const people = await listParticipants(db, user);
    const draft = parseQuickEntry("昨天 盒马 买菜 100 @室友", { today: "2026-09-29", participants: people, defaultCurrency: "CNY" });
    const r = await createQuickEntry(db, user, { ...draft, amountMinor: draft.amountMinor! });
    expect(r.myShareMinor).toBe(5000);
    const tx = (await db.select().from(transactions).where(eq(transactions.id, r.transactionId)).limit(1))[0]!;
    expect(tx).toMatchObject({ amountMinor: -10000, kind: "expense", source: "manual", occurredAt: "2026-09-28T12:00:00+08:00" });
    expect(tx.dedupKey).toMatch(/^manual:[0-9a-f-]{36}$/);
    const cat = (await db.select().from(categories).where(eq(categories.id, tx.categoryId!)).limit(1))[0]!;
    expect(cat.name).toBe("买菜");
    const acct = (await db.select().from(accounts).where(eq(accounts.id, tx.accountId!)).limit(1))[0]!;
    expect(acct).toMatchObject({ name: "手动记账", kind: "cash" });
    await createQuickEntry(db, user, { ...draft, amountMinor: 100, participantIds: [], description: "x", categoryHint: null });
    expect(await db.select().from(accounts)).toHaveLength(1);
    expect(await balances(db, user)).toEqual([expect.objectContaining({ participantId: roommate.id, owedToMeMinor: 5000 })]);
  });

  it("friend paid: account null, I owe my share; unknown hint falls back to 其他", async () => {
    const db = await freshDb();
    const roommate = await createParticipant(db, user, "室友");
    const draft = parseQuickEntry("@室友 付 80 神秘开销", { today: "2026-09-29", participants: await listParticipants(db, user), defaultCurrency: "CNY" });
    const r = await createQuickEntry(db, user, { ...draft, amountMinor: draft.amountMinor! });
    expect(r.myShareMinor).toBe(4000);
    const tx = (await db.select().from(transactions).where(eq(transactions.id, r.transactionId)).limit(1))[0]!;
    expect(tx.accountId).toBeNull();
    expect((await db.select().from(categories).where(eq(categories.id, tx.categoryId!)).limit(1))[0]!.name).toBe("其他");
    expect((await balances(db, user))[0]).toMatchObject({ participantId: roommate.id, owedToMeMinor: -4000 });
  });

  it("friend paid with a third person: I owe the payer only my share, nothing with the third", async () => {
    const db = await freshDb();
    const b = await createParticipant(db, user, "B");
    await createParticipant(db, user, "A");
    const draft = parseQuickEntry("@B 付 90 @A 晚饭", { today: "2026-09-29", participants: await listParticipants(db, user), defaultCurrency: "CNY" });
    const r = await createQuickEntry(db, user, { ...draft, amountMinor: draft.amountMinor! });
    expect(r.myShareMinor).toBe(3000);
    expect(await balances(db, user)).toEqual([expect.objectContaining({ participantId: b.id, owedToMeMinor: -3000 })]);
  });
});
