import { accounts, type Db, transactions } from "@yomi/db";
import { testDb } from "@yomi/db/testing";
import { describe, expect, it } from "vitest";
import { seed } from "../seed";
import { getCurrentUser } from "../user";
import {
  addIdentity,
  archiveParticipant,
  claimCounterparty,
  createParticipant,
  guessAliasKind,
  ignoreCounterparty,
  listIdentities,
  listUnclaimedCounterparties,
  markAsSettlement,
  normalizeIdentity,
  p2pParty,
  removeIdentity,
  settlementCandidates,
  SplitError,
} from "./index";

const user = getCurrentUser();
const TODAY = "2026-09-29";

async function freshDb(): Promise<Db> {
  const db = await testDb();
  await seed(db);
  await db.insert(accounts).values({ userId: user.id, name: "钱包", kind: "wallet", currency: "CNY" });
  return db;
}

let seq = 0;
async function addTx(db: Db, p: Partial<typeof transactions.$inferInsert> & { amountMinor: number }): Promise<number> {
  seq += 1;
  return (await db
    .insert(transactions)
    .values({
      userId: user.id,
      accountId: 1,
      occurredAt: "2026-09-10T12:00:00+08:00",
      currency: "CNY",
      kind: p.amountMinor < 0 ? "expense" : "income",
      source: "wechat",
      dedupKey: `id-test:${seq}`,
      ...p,
    })
    .returning({ id: transactions.id }))[0]!.id;
}

describe("normalizeIdentity", () => {
  it("trims, collapses spaces and lowercases; phones keep digits; emails lose spaces", () => {
    expect(normalizeIdentity("zelle_name", "  ALEX   Tester ")).toBe("alex tester");
    expect(normalizeIdentity("wechat", "阿杰　🌙")).toBe("阿杰 🌙");
    expect(normalizeIdentity("zelle_phone", "+1 (512) 555-0100")).toBe("15125550100");
    expect(normalizeIdentity("zelle_email", " Alex.T@Example.COM ")).toBe("alex.t@example.com");
  });

  it("guesses alias kinds like migration 0006", () => {
    expect(guessAliasKind("阿杰")).toBe("wechat");
    expect(guessAliasKind("A-Wang🌙")).toBe("wechat");
    expect(guessAliasKind("wxid_abc123")).toBe("wechat");
    expect(guessAliasKind("Alex Tester")).toBe("zelle_name");
  });
});

describe("identities CRUD", () => {
  it("adds idempotently, refuses someone else's value, removes", async () => {
    const db = await freshDb();
    const a = await createParticipant(db, user, "A");
    const b = await createParticipant(db, user, "B");
    const i = await addIdentity(db, user, a.id, { kind: "zelle_name", value: "ALEX  TESTER" });
    expect(i).toMatchObject({ value: "ALEX TESTER", normalized: "alex tester", source: "manual" });
    expect((await addIdentity(db, user, a.id, { kind: "zelle_name", value: "alex tester" })).id).toBe(i.id);
    await expect(addIdentity(db, user, b.id, { kind: "zelle_name", value: "Alex Tester" })).rejects.toThrow(expect.objectContaining({ code: "identity_taken", params: { value: "ALEX TESTER", name: "A" } }));
    // Same value, other kind: allowed (a WeChat nickname can equal a Zelle name).
    expect((await addIdentity(db, user, b.id, { kind: "wechat", value: "Alex Tester" })).participantId).toBe(b.id);
    await expect(addIdentity(db, user, a.id, { kind: "zelle_phone", value: "call me" })).rejects.toThrow(SplitError);
    await removeIdentity(db, user, i.id);
    expect(await listIdentities(db, user, a.id)).toEqual([]);
    await expect(removeIdentity(db, user, i.id)).rejects.toThrow(expect.objectContaining({ code: "identity_not_found" }));
  });
});

describe("p2pParty", () => {
  it("reads the party per source", () => {
    expect(p2pParty({ source: "wechat", sourceCategory: "微信红包（单发）", counterparty: "阿杰", description: "/" })).toEqual({ kind: "wechat", value: "阿杰", account: null });
    expect(p2pParty({ source: "wechat", sourceCategory: "商户消费", counterparty: "麦当劳", description: "" })).toBeNull();
    expect(
      p2pParty({ source: "alipay", sourceCategory: "转账红包", counterparty: "王小二", description: "", raw: { 对方账号: "wx***@qq.com" } }),
    ).toEqual({ kind: "alipay", value: "王小二", account: "wx***@qq.com" });
    expect(p2pParty({ source: "boa_csv", sourceCategory: "Zelle", counterparty: "ALEX TESTER", description: "" })).toMatchObject({ kind: "zelle_name", value: "ALEX TESTER" });
    expect(
      p2pParty({ source: "plaid", sourceCategory: "TRANSFER_IN/TRANSFER_IN_FROM_APPS", counterparty: "Zelle payment from JO DOE Conf# a1", description: "Zelle payment from JO DOE Conf# a1" }),
    ).toMatchObject({ kind: "zelle_name", value: "JO DOE" });
    expect(p2pParty({ source: "plaid", sourceCategory: "TRANSFER_OUT/TRANSFER_OUT_FROM_APPS", counterparty: "Venmo", description: "VENMO PAYMENT 1234" })).toBeNull();
    expect(p2pParty({ source: "plaid", sourceCategory: "TRANSFER_IN/TRANSFER_IN_FROM_APPS", counterparty: "VENMO FROM Sam Lee", description: "VENMO" })).toMatchObject({ kind: "venmo", value: "Sam Lee" });
  });
});

describe("listUnclaimedCounterparties", () => {
  async function ledger() {
    const db = await freshDb();
    const usd = { currency: "USD", accountId: null };
    await addTx(db, { amountMinor: 5000, counterpartyRaw: "Momo", sourceCategory: "转账", occurredAt: "2026-09-20T10:00:00+08:00" });
    await addTx(db, { amountMinor: -2000, counterpartyRaw: " momo ", sourceCategory: "微信红包（单发）", occurredAt: "2026-08-01T10:00:00+08:00" });
    await addTx(db, { amountMinor: 800, counterpartyRaw: "Momo", sourceCategory: "二维码收款", occurredAt: "2026-09-21T10:00:00+08:00", status: "closed" });
    await addTx(db, { amountMinor: -900, counterpartyRaw: "盒马", sourceCategory: "商户消费" });
    await addTx(db, {
      amountMinor: 30000,
      source: "alipay",
      counterpartyRaw: "王小二",
      sourceCategory: "转账红包",
      raw: { 对方账号: "138****0000" },
      occurredAt: "2026-09-01T10:00:00+08:00",
    });
    await addTx(db, { ...usd, amountMinor: 2500, source: "boa_csv", sourceCategory: "Zelle", counterpartyRaw: "ALEX TESTER", occurredAt: "2026-09-15T12:00:00-05:00" });
    const plaid = await addTx(db, {
      ...usd,
      amountMinor: -1200,
      kind: "expense",
      source: "plaid",
      sourceCategory: "TRANSFER_OUT/TRANSFER_OUT_FROM_APPS",
      counterpartyRaw: "Zelle payment to Alex Tester Conf# z9",
      descriptionRaw: "Zelle payment to Alex Tester Conf# z9",
      occurredAt: "2026-09-25T00:00:00-05:00",
    });
    // The BoA CSV copy of the Plaid row: linked as duplicate, must not count twice.
    await addTx(db, { ...usd, amountMinor: -1200, source: "boa_csv", sourceCategory: "Zelle", counterpartyRaw: "Alex Tester", occurredAt: "2026-09-25T00:00:00-05:00", duplicateOfId: plaid });
    await addTx(db, { ...usd, amountMinor: -500, source: "plaid", sourceCategory: "TRANSFER_OUT/TRANSFER_OUT_FROM_APPS", counterpartyRaw: "Venmo", descriptionRaw: "VENMO PAYMENT" });
    return db;
  }

  it("groups across sources by (kind, normalized) with per-currency totals, recent and frequent first", async () => {
    const db = await ledger();
    const list = await listUnclaimedCounterparties(db, user, { today: TODAY });
    expect(list.map((c) => [c.kind, c.value, c.inCount, c.outCount])).toEqual([
      ["zelle_name", "Alex Tester", 1, 1],
      ["wechat", "Momo", 1, 1],
      ["alipay", "王小二", 1, 0],
    ]);
    const alex = list[0]!;
    expect(alex).toMatchObject({
      normalized: "alex tester",
      totals: [{ currency: "USD", inMinor: 2500, outMinor: 1200 }],
      lastDirection: "out",
      sources: ["boa_csv", "plaid"],
      suggestedParticipantId: null,
    });
    expect(list[1]).toMatchObject({ totals: [{ currency: "CNY", inMinor: 5000, outMinor: 2000 }], firstAt: "2026-08-01T10:00:00+08:00", lastDirection: "in" });
    expect(list[2]).toMatchObject({ account: "138****0000" });
  });

  it("excludes claimed and ignored values, suggests a participant whose name equals the value", async () => {
    const db = await ledger();
    const a = await createParticipant(db, user, "Momo");
    expect((await listUnclaimedCounterparties(db, user, { today: TODAY })).find((c) => c.value === "Momo")?.suggestedParticipantId).toBe(a.id);
    await claimCounterparty(db, user, { kind: "zelle_name", value: "alex tester", newParticipantName: "Alex" });
    await ignoreCounterparty(db, user, { kind: "alipay", value: " 王小二 " });
    expect((await listUnclaimedCounterparties(db, user, { today: TODAY })).map((c) => c.value)).toEqual(["Momo"]);
    // Claiming again after an ignore lifts the ignore.
    await addIdentity(db, user, a.id, { kind: "alipay", value: "王小二" });
    await ignoreCounterparty(db, user, { kind: "wechat", value: "momo" });
    expect(await listUnclaimedCounterparties(db, user, { today: TODAY })).toEqual([]);
  });

  it("an alipay identity bound to 对方账号 hides the name too", async () => {
    const db = await ledger();
    const a = await createParticipant(db, user, "二哥");
    await addIdentity(db, user, a.id, { kind: "alipay", value: "138****0000" });
    expect((await listUnclaimedCounterparties(db, user, { today: TODAY })).some((c) => c.kind === "alipay")).toBe(false);
    expect((await settlementCandidates(db, user, { today: TODAY })).find((c) => c.counterparty === "王小二")).toMatchObject({ suggestedParticipantId: a.id, match: "alias_exact" });
  });
});

describe("claim → candidates", () => {
  it("historical transfers become candidates for the claimed participant, including old and outgoing ones", async () => {
    const db = await freshDb();
    const usd = { currency: "USD", accountId: null };
    const old = await addTx(db, { amountMinor: 4000, counterpartyRaw: "Momo", sourceCategory: "转账", occurredAt: "2026-03-01T10:00:00+08:00" });
    const zin = await addTx(db, { ...usd, amountMinor: 2500, source: "boa_csv", sourceCategory: "Zelle", counterpartyRaw: "ALEX TESTER", occurredAt: "2026-09-15T12:00:00-05:00" });
    const zout = await addTx(db, { ...usd, amountMinor: -1200, source: "boa_csv", sourceCategory: "Zelle", counterpartyRaw: "ALEX TESTER", occurredAt: "2026-09-16T12:00:00-05:00" });
    const before = await settlementCandidates(db, user, { today: TODAY });
    expect(before.map((c) => [c.transactionId, c.match])).toEqual([[zin, "none"]]);

    const momo = await claimCounterparty(db, user, { kind: "wechat", value: "Momo", newParticipantName: "莫莫" });
    const alex = await createParticipant(db, user, "Alex");
    await expect(claimCounterparty(db, user, { kind: "zelle_name", value: "ALEX TESTER" })).rejects.toThrow(SplitError);
    await claimCounterparty(db, user, { kind: "zelle_name", value: "ALEX TESTER", participantId: alex.id });
    await expect(claimCounterparty(db, user, { kind: "zelle_name", value: "alex tester", participantId: momo.participantId })).rejects.toThrow(/already belongs to Alex/);

    const after = await settlementCandidates(db, user, { today: TODAY });
    expect(after.map((c) => [c.transactionId, c.match, c.suggestedParticipantId]).sort((x, y) => (x[0] as number) - (y[0] as number))).toEqual([
      [old, "alias_exact", momo.participantId],
      [zin, "alias_exact", alex.id],
      [zout, "alias_exact", alex.id],
    ]);
    // Archived participants drop out of matching but keep their identities (still not "unclaimed").
    await archiveParticipant(db, user, alex.id);
    expect((await settlementCandidates(db, user, { today: TODAY })).find((c) => c.transactionId === zout)).toBeUndefined();
    expect(await listUnclaimedCounterparties(db, user, { today: TODAY })).toEqual([]);
  });

  it("marking an unknown transfer as settlement binds its party as a claimed identity", async () => {
    const db = await freshDb();
    const a = await createParticipant(db, user, "室友");
    const t = await addTx(db, { amountMinor: 1000, source: "boa_csv", currency: "USD", accountId: null, sourceCategory: "Zelle", counterpartyRaw: "JO DOE", occurredAt: "2026-09-20T12:00:00-05:00" });
    await markAsSettlement(db, user, t, { participantId: a.id });
    expect((await listIdentities(db, user, a.id)).map((i) => [i.kind, i.value, i.source])).toEqual([["zelle_name", "JO DOE", "claimed"]]);
  });
});
