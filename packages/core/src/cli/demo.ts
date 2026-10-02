// Synthetic demo ledger for UI work: `pnpm demo:db [dir]` (default data/demo-pglite, a PGlite data directory).
// Deletes the directory first; refuses while another process (a dev server) has it open.
// Everything goes through the public core API (except the demo brokerage login row, which Plaid would
// create); all names, merchants, card numbers and brokerage accounts are made up.
import path from "node:path";
import { and, eq } from "@yomi/db/orm";
import { accounts, bankAccounts, bankConnections, closeDb, createDb, migrate } from "@yomi/db";
import { bucketTotals, type InvestHoldingRow, type InvestStatement, type NormalizedRow, type ParseResult, type SourceId } from "@yomi/importers";
import {
  balances,
  commitImport,
  createFriendPaidExpense,
  createParticipant,
  createQuickEntry,
  formatMinor,
  getCurrentUser,
  listCategories,
  listTransactions,
  markAsSettlement,
  seed,
  setCategory,
  setMonthlyTarget,
  setSplit,
  setStartingBalance,
  toggleParticipant,
  upsertBalanceSnapshot,
  writeStatement,
} from "../index";
import { prepareDemoDir } from "./demo-dir";

const target = prepareDemoDir(process.argv[2], "data/demo-pglite");

// ---------- deterministic randomness ----------
let state = 20260929;
function rnd(): number {
  state = (state + 0x6d2b79f5) | 0;
  let t = state;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}
const int = (lo: number, hi: number) => lo + Math.floor(rnd() * (hi - lo + 1));
const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rnd() * xs.length)]!;
const cents = (lo: number, hi: number) => Math.round((lo + rnd() * (hi - lo)) * 100);
const pad = (n: number, w = 2) => String(n).padStart(w, "0");
const digits = (n: number) => Array.from({ length: n }, () => int(0, 9)).join("");

const START = Date.UTC(2026, 6, 1);
const TODAY = "2026-09-29";
const DAYS = Array.from({ length: 91 }, (_, i) => new Date(START + i * 86_400_000).toISOString().slice(0, 10));
const randomDay = () => pick(DAYS);
function addDays(day: string, n: number): string {
  const d = new Date(`${day}T00:00:00Z`).getTime() + n * 86_400_000;
  const out = new Date(d).toISOString().slice(0, 10);
  return out > TODAY ? TODAY : out;
}
const at = (day: string, h = int(8, 22), m = int(0, 59), s = int(0, 59)) => `${day}T${pad(h)}:${pad(m)}:${pad(s)}+08:00`;
const yuan = (minor: number) => (Math.abs(minor) / 100).toFixed(2);

// ---------- row building ----------
type Draft = Omit<NormalizedRow, "lineNo" | "raw" | "originalAmountMinor" | "originalCurrency" | "status"> & {
  status?: NormalizedRow["status"];
  originalAmountMinor?: number | null;
  originalCurrency?: string | null;
  tag?: string;
};

const keyOf = (r: { source: string; occurredAt: string; amountMinor: number; counterparty: string }) =>
  `${r.source}|${r.occurredAt}|${r.amountMinor}|${r.counterparty}`;
const tagged = new Map<string, string[]>();
const usedKeys = new Set<string>();

function finish(source: SourceId, drafts: Draft[], rawOf: (d: Draft) => Record<string, string>): NormalizedRow[] {
  drafts.sort((a, b) => a.occurredAt.localeCompare(b.occurredAt));
  return drafts.map((d, i) => {
    // Keep (source, time, amount, counterparty) unique so rows can be found again after import.
    while (usedKeys.has(keyOf(d))) d.occurredAt = d.occurredAt.replace(/:(\d{2})\+/, (_, s: string) => `:${pad((Number(s) + 1) % 60)}+`);
    usedKeys.add(keyOf(d));
    if (d.tag) tagged.set(d.tag, [...(tagged.get(d.tag) ?? []), keyOf(d)]);
    const { tag: _tag, ...rest } = d;
    return {
      ...rest,
      source,
      lineNo: i + 1,
      status: d.status ?? "ok",
      originalAmountMinor: d.originalAmountMinor ?? null,
      originalCurrency: d.originalCurrency ?? null,
      raw: rawOf(d),
    };
  });
}

// ---------- Alipay ----------
function alipayRows(): NormalizedRow[] {
  const pays = ["账户余额", "招商银行储蓄卡(0001)", "交通银行信用卡(0002)&立减金", "交通银行信用卡(0002)"];
  const shops: [string, string, string, number, number][] = [
    ["瑞幸咖啡", "生椰拿铁 大杯", "餐饮美食", 9.9, 22],
    ["盒马鲜生", "盒马鲜生订单", "日用百货", 48, 230],
    ["美团外卖", "美团外卖订单", "餐饮美食", 24, 72],
    ["滴滴出行", "快车行程", "交通出行", 12, 48],
  ];
  const orderNo = (day: string) => `${day.replace(/-/g, "")}22001${digits(14)}`;
  const d: Draft[] = [];
  const out = (day: string, counterparty: string, description: string, sourceCategory: string, minor: number, extra: Partial<Draft> = {}) => {
    const row: Draft = {
      source: "alipay",
      externalId: orderNo(day),
      occurredAt: at(day),
      amountMinor: -minor,
      currency: "CNY",
      direction: "out",
      kind: "expense",
      counterparty,
      description,
      sourceCategory,
      paymentMethod: pick(pays),
      ...extra,
    };
    d.push(row);
    return row;
  };
  const refund = (orig: Draft, minor: number, kind: "refund" | "transfer", days: number) =>
    d.push({
      source: "alipay",
      externalId: `${orig.externalId}_${digits(12)}`,
      occurredAt: at(addDays(orig.occurredAt.slice(0, 10), days)),
      amountMinor: minor,
      currency: "CNY",
      direction: "neutral",
      kind,
      counterparty: orig.counterparty,
      description: `退款-${orig.description}`,
      sourceCategory: "退款",
      paymentMethod: orig.paymentMethod,
    });

  for (let i = 0; i < 30; i++) {
    const [cp, desc, cat, lo, hi] = pick(shops);
    out(randomDay(), cp, desc, cat, cents(lo, hi));
  }
  for (const month of ["07", "08", "09"]) {
    out(`2026-${month}-03`, "哔哩哔哩", "大会员连续包月", "文化休闲", 2500, { paymentMethod: "账户余额" });
    out(`2026-${month}-15`, "中国联通", "话费充值 100元", "充值缴费", 10000);
  }
  const c1 = out("2026-07-18", "盒马鲜生", "盒马鲜生订单", "日用百货", 15680, { status: "closed" });
  refund(c1, 15680, "transfer", 0);
  const c2 = out("2026-09-06", "美团外卖", "美团外卖订单", "餐饮美食", 4550, { status: "closed" });
  refund(c2, 4550, "transfer", 0);
  const partial = out("2026-08-22", "盒马鲜生", "盒马鲜生订单", "日用百货", 18860, { tag: "hema" });
  refund(partial, 2390, "refund", 1);
  // A friend nobody has claimed yet (also on WeChat): shows up in the "who is transferring with you" list.
  out("2026-09-10", "Momo", "转账", "转账红包", 8800, { direction: "in", kind: "income", amountMinor: 8800, paymentMethod: "账户余额" });

  return finish("alipay", d, (r) => ({
    交易时间: r.occurredAt.slice(0, 19).replace("T", " "),
    交易分类: r.sourceCategory ?? "",
    交易对方: r.counterparty,
    商品说明: r.description,
    "收/支": r.direction === "out" ? "支出" : r.direction === "in" ? "收入" : "不计收支",
    金额: yuan(r.amountMinor),
    "收/付款方式": r.paymentMethod ?? "",
    交易状态: r.status === "closed" ? "交易关闭" : r.kind === "refund" || r.sourceCategory === "退款" ? "退款成功" : "交易成功",
    交易订单号: r.externalId ?? "",
  }));
}

// ---------- WeChat ----------
function wechatRows(): NormalizedRow[] {
  const pays = ["零钱", "招商银行储蓄卡(0001)", "交通银行信用卡(0002)"];
  const shops: [string, string, number, number][] = [
    ["麦当劳", "麦当劳点餐", 12, 45],
    ["喜茶", "多肉葡萄", 15, 32],
    ["全家便利店", "全家FamilyMart", 6, 38],
    ["美团", "美团订单", 20, 80],
    ["罗森", "LAWSON罗森", 5, 30],
  ];
  const txNo = () => `42000${digits(23)}`;
  const d: Draft[] = [];
  const row = (
    day: string,
    type: string,
    counterparty: string,
    description: string,
    amountMinor: number,
    direction: Draft["direction"],
    kind: Draft["kind"],
    paymentMethod: string | null,
    tag?: string,
  ) =>
    d.push({
      source: "wechat",
      externalId: txNo(),
      occurredAt: at(day),
      amountMinor,
      currency: "CNY",
      direction,
      kind,
      counterparty,
      description,
      sourceCategory: type,
      paymentMethod,
      tag,
    });

  for (let i = 0; i < 41; i++) {
    const [cp, desc, lo, hi] = pick(shops);
    row(randomDay(), "商户消费", cp, desc, -cents(lo, hi), "out", "expense", pick(pays));
  }
  row("2026-08-16", "商户消费", "海底捞火锅", "海底捞(望京店)", -38600, "out", "expense", "招商银行储蓄卡(0001)", "haidilao");
  // Transfers and red packets with friends.
  row("2026-07-10", "转账", "阿杰", "转账备注:车费", -20000, "out", "expense", "零钱");
  row("2026-09-02", "转账", "阿杰", "转账备注:奶茶", -15000, "out", "expense", "零钱");
  row("2026-07-25", "转账", "小李", "转账备注:电影票", -8800, "out", "expense", "零钱");
  row("2026-09-12", "转账", "小李", "转账备注:演唱会门票", -30000, "out", "expense", "零钱");
  row("2026-09-13", "转账-退款", "小李", "/", 30000, "neutral", "refund", null);
  row("2026-07-07", "微信红包（单发）", "阿杰", "/", -666, "out", "expense", "零钱");
  row("2026-08-08", "微信红包（单发）", "小李", "/", -888, "out", "expense", "零钱");
  row("2026-08-30", "微信红包（群红包）", "周末饭搭子", "/", -5200, "out", "expense", "零钱");
  row("2026-09-17", "微信红包（单发）", "阿杰", "/", -6600, "out", "expense", "零钱");
  row("2026-07-14", "微信红包", "小李", "/", 1888, "in", "income", null);
  row("2026-08-01", "微信红包", "阿杰", "/", 520, "in", "income", null);
  row("2026-08-30", "微信红包", "周末饭搭子", "/", 1234, "in", "income", null);
  row("2026-09-21", "微信红包", "小李", "/", 6600, "in", "income", null);
  row("2026-07-28", "转账", "小李", "/", 12000, "in", "income", null);
  row("2026-08-20", "转账", "阿杰", "/", 70000, "in", "income", null, "settle_aug");
  row("2026-09-24", "转账", "阿杰", "/", 42000, "in", "income", null, "candidate_sep");
  // Momo is not a participant yet: an unclaimed counterparty in /split until someone claims it.
  row("2026-08-11", "转账", "Momo", "转账备注:房租分摊", -50000, "out", "expense", "零钱");
  row("2026-09-18", "转账", "Momo", "/", 25000, "in", "income", null);
  row("2026-07-31", "零钱提现", "招商银行(0001)", "零钱提现", -50000, "neutral", "transfer", "零钱");
  row("2026-09-05", "零钱提现", "招商银行(0001)", "零钱提现", -30000, "neutral", "transfer", "零钱");

  return finish("wechat", d, (r) => ({
    交易时间: r.occurredAt.slice(0, 19).replace("T", " "),
    交易类型: r.sourceCategory ?? "",
    交易对方: r.counterparty,
    商品: r.description,
    "收/支": r.direction === "out" ? "支出" : r.direction === "in" ? "收入" : "/",
    "金额(元)": yuan(r.amountMinor),
    支付方式: r.paymentMethod ?? "/",
    当前状态: r.kind === "refund" ? "已退款" : r.direction === "in" ? "已收钱" : "支付成功",
    交易单号: r.externalId ?? "",
  }));
}

// ---------- ICBC credit card (USD, a few HKD) ----------
/** Card balance before the first demo row (owed, so negative). */
const ICBC_OPENING = -95000;
function icbcRows(): NormalizedRow[] {
  const d: Draft[] = [];
  const pm = "工商银行信用卡(0003)";
  const buy = (day: string, place: string, minor: number, tag?: string, hkd?: number) => {
    const row: Draft = {
      source: "icbc_pdf",
      externalId: null,
      occurredAt: at(day),
      amountMinor: -minor,
      currency: "USD",
      originalAmountMinor: hkd === undefined ? null : -hkd,
      originalCurrency: hkd === undefined ? null : "HKD",
      direction: "out",
      kind: "expense",
      counterparty: place,
      description: "消费",
      sourceCategory: "消费",
      paymentMethod: pm,
      tag,
    };
    d.push(row);
    return row;
  };
  const credit = (day: string, place: string, minor: number, kind: Draft["kind"], summary: string) =>
    d.push({
      source: "icbc_pdf",
      externalId: null,
      occurredAt: at(day),
      amountMinor: minor,
      currency: "USD",
      direction: "in",
      kind,
      counterparty: place,
      description: summary,
      sourceCategory: summary,
      paymentMethod: pm,
    });

  const groceries: [string, number, number][] = [
    ["WEEE! INC FREMONT CA", 40, 140],
    ["KROGER #412 HOUSTON TX", 25, 110],
    ["H-E-B #221 HOUSTON TX", 20, 95],
  ];
  for (let i = 0; i < 36; i++) {
    const [place, lo, hi] = pick(groceries);
    buy(randomDay(), place, cents(lo, hi), "grocery");
  }
  const amazon: Draft[] = [];
  for (let i = 0; i < 14; i++) {
    amazon.push(buy(randomDay(), `AMAZON MKTPL*${digits(2)}${pick(["AB", "KQ", "ZT", "MW"])}${digits(2)} SEATTLE WA`, cents(9, 85), "amazon"));
  }
  for (let i = 0; i < 17; i++) buy(randomDay(), "UBER *TRIP HELP.UBER.COM CA", cents(9, 32));
  for (let i = 0; i < 12; i++) buy(randomDay(), "UBER *EATS HELP.UBER.COM CA", cents(18, 45));
  for (let i = 0; i < 10; i++) buy(randomDay(), "TST*BUSY BEE CAFE HOUSTON TX", cents(8, 16));
  for (let i = 0; i < 5; i++) buy(randomDay(), "SQ *PHO HOUSE HOUSTON TX", cents(14, 28));
  buy("2026-07-19", "SQ *PHO HOUSE HOUSTON TX", 5840, "dinner3");
  buy("2026-08-23", "SQ *PHO HOUSE HOUSTON TX", 7215, "dinner3");
  buy("2026-09-13", "TST*BUSY BEE CAFE HOUSTON TX", 4860, "dinner3");
  for (const day of ["2026-07-02", "2026-07-16", "2026-07-30", "2026-08-13", "2026-08-27", "2026-09-10"]) {
    buy(day, "HOME KITCHEN MEALS NEW YORK NY", cents(79, 96));
  }
  for (const month of ["07", "08", "09"]) {
    buy(`2026-${month}-07`, "NETFLIX.COM LOS GATOS CA", 1549, month === "08" ? "netflix_full" : undefined);
    buy(`2026-${month}-12`, "SPOTIFY USA NEW YORK NY", 1199);
  }
  // A long weekend in Hong Kong: booked in USD, charged in HKD.
  for (const [day, place, hkd] of [
    ["2026-08-09", "MANNINGS (HK) LTD HONG KONG", 13850],
    ["2026-08-10", "MTR CORPORATION HONG KONG", 5200],
    ["2026-08-11", "TSUI WAH RESTAURANT HONG KONG", 28600],
  ] as const) {
    buy(day, place, Math.round(hkd / 7.8), undefined, hkd);
  }
  for (const orig of amazon.slice(0, 2)) {
    credit(addDays(orig.occurredAt.slice(0, 10), int(2, 6)), orig.counterparty, -orig.amountMinor, "refund", "退货");
  }
  const kroger = d.find((r) => r.counterparty.startsWith("KROGER"))!;
  credit(addDays(kroger.occurredAt.slice(0, 10), 1), kroger.counterparty, 649, "refund", "退货");
  credit("2026-08-04", "ICBCVisaMerchantRebate", 1250, "income", "返现");
  credit("2026-09-03", "ICBCVisaMerchantRebate", 830, "income", "返现");
  credit("2026-08-25", "ONLINE PAYMENT THANK YOU", 165000, "transfer", "还款");
  credit("2026-09-25", "ONLINE PAYMENT THANK YOU", 182000, "transfer", "还款");

  const cur = (c: string) => (c === "HKD" ? "港币" : "美元");
  // 账户余额 (account balance) after each row, negative while owed; rows arrive oldest first.
  let balance = ICBC_OPENING;
  return finish("icbc_pdf", d, (r) => ({
    交易日期: r.occurredAt.slice(0, 10),
    入账日期: r.occurredAt.slice(0, 19).replace("T", " "),
    交易卡号: "****0003",
    "收/支": r.direction === "out" ? "借" : "贷",
    摘要: r.description,
    交易场所: r.counterparty,
    交易币种: cur(r.originalCurrency ?? r.currency),
    交易金额: yuan(r.originalAmountMinor ?? r.amountMinor),
    入账币种: cur(r.currency),
    入账金额: yuan(r.amountMinor),
    账户余额: `${(balance += r.amountMinor) < 0 ? "-" : ""}${yuan(balance)}`,
  }));
}

// ---------- build ----------
const db = await createDb(target);
await migrate(db);
await seed(db);
const user = getCurrentUser();

const files: [string, NormalizedRow[]][] = [
  ["支付宝交易明细(20260701-20260929).csv", alipayRows()],
  ["微信支付账单(20260701-20260929).xlsx", wechatRows()],
  ["工商银行信用卡对账单-2026Q3.pdf", icbcRows()],
];
const batchCounts: string[] = [];
for (const [fileName, rows] of files) {
  const source = rows[0]!.source;
  const parsed: ParseResult = {
    source,
    rows,
    declared: bucketTotals(rows),
    periodStart: "2026-07-01",
    periodEnd: TODAY,
    warnings: [],
  };
  const bytes = new TextEncoder().encode(`demo:${fileName}:${JSON.stringify(rows)}`);
  const r = await commitImport(db, user, async () => parsed, bytes, fileName, { backup: false });
  if (!r.reconciliation.ok) throw new Error(`${source}: reconciliation failed`);
  batchCounts.push(`${source} ${r.inserted}`);
}

const idByKey = new Map(
  (await listTransactions(db, user, { limit: 5000 })).items.map((t) => [
    keyOf({ source: t.source, occurredAt: t.occurredAt, amountMinor: t.amountMinor, counterparty: t.counterpartyRaw }),
    t.id,
  ]),
);
const ids = (tag: string) =>
  (tagged.get(tag) ?? []).map((k) => {
    const id = idByKey.get(k);
    if (id === undefined) throw new Error(`demo row not found after import: ${k}`);
    return id;
  });
const one = (tag: string) => ids(tag)[0]!;

// Merchant rule: 盒马 (Hema) counts as groceries (买菜), not household (日用).
const cats = new Map((await listCategories(db, user)).map((c) => [c.name, c.id]));
await setCategory(db, user, one("hema"), cats.get("买菜")!, { applyToMerchant: true });

const roommate = await createParticipant(db, user, "室友", [{ kind: "wechat", value: "阿杰" }]);
const xiaoli = await createParticipant(db, user, "小李");

// ~25 shared grocery / household rows with the roommate.
const shuffled = <T>(xs: T[]) => xs.map((x) => [rnd(), x] as const).sort((a, b) => a[0] - b[0]).map(([, x]) => x);
for (const id of [...shuffled(ids("grocery")).slice(0, 22), ...shuffled(ids("amazon")).slice(0, 3)]) {
  await toggleParticipant(db, user, id, roommate.id);
}
for (const id of ids("dinner3")) await setSplit(db, user, id, { participantIds: [roommate.id, xiaoli.id], mode: "equal" });
await setSplit(db, user, one("netflix_full"), { participantIds: [roommate.id], mode: "full" });
await toggleParticipant(db, user, one("haidilao"), xiaoli.id);

await createFriendPaidExpense(db, user, {
  payerId: roommate.id,
  totalMinor: 9640,
  currency: "USD",
  occurredAt: "2026-08-05",
  description: "Utilities (Aug)",
  categoryId: cats.get("居住")!,
});
await createFriendPaidExpense(db, user, {
  payerId: roommate.id,
  totalMinor: 6000,
  currency: "USD",
  occurredAt: "2026-09-03",
  description: "Internet (Sep)",
  categoryId: cats.get("居住")!,
});

await createQuickEntry(db, user, {
  amountMinor: 1850,
  currency: "USD",
  description: "Farmers market",
  date: "2026-09-20",
  participantIds: [],
  payerId: null,
  mode: "equal",
  categoryHint: "买菜",
});
await createQuickEntry(db, user, {
  amountMinor: 3200,
  currency: "USD",
  description: "Paper towels and detergent",
  date: "2026-09-26",
  participantIds: [roommate.id],
  payerId: null,
  mode: "equal",
  categoryHint: "日用",
});

// August: the roommate paid back in RMB over WeChat. The September transfer stays a candidate.
await markAsSettlement(db, user, one("settle_aug"), {
  participantId: roommate.id,
  amountMinor: 9800,
  currency: "USD",
});

// One default target only (month null); USD is where most spending happens.
await setMonthlyTarget(db, user, { month: null, amountMinor: 150000, currency: "USD" });

// ---------- investments: a synthetic IBKR account and a Plaid brokerage, two daily snapshots each ----------
// Tickers are real listings; account ids, quantities, prices and costs are made up.
const holding = (account: string, security: string | null, currency: string, quantity: string, price: string, marketValue: string, costBasis: string | null): InvestHoldingRow => ({
  accountExternalId: account,
  securityExternalId: security,
  currency,
  quantity,
  price,
  marketValue,
  costBasis,
  raw: { demo: true },
});
const ibkrDay = (asOf: string, [aapl, vti, tencent]: [string, string, string], values: [string, string, string]): InvestStatement => ({
  source: "ibkr",
  asOf,
  accounts: [{ externalId: "U0000001", name: "IBKR U0000001", currency: "USD" }],
  securities: [
    { externalId: "265598", symbol: "AAPL", name: "APPLE INC", type: "STK", currency: "USD", isin: null, cusip: null, multiplier: null },
    { externalId: "12345001", symbol: "VTI", name: "VANGUARD TOTAL STOCK MKT ETF", type: "STK", currency: "USD", isin: null, cusip: null, multiplier: null },
    { externalId: "12345002", symbol: "700", name: "TENCENT HOLDINGS LTD", type: "STK", currency: "HKD", isin: null, cusip: null, multiplier: null },
  ],
  holdings: [
    holding("U0000001", "265598", "USD", "25", aapl, values[0], "4380.50"),
    holding("U0000001", "12345001", "USD", "40", vti, values[1], "10212.40"),
    holding("U0000001", "12345002", "HKD", "100", tencent, values[2], "38420"),
    holding("U0000001", null, "USD", "1234.56", "1", "1234.56", null),
    holding("U0000001", null, "HKD", "500", "1", "500", null),
  ],
  transactions: [],
  warnings: [],
});
// Weekly closes before the last two days, so the Assets history has a shape. Prices drift up slowly.
const FRIDAYS = ["2026-07-03", "2026-07-10", "2026-07-17", "2026-07-24", "2026-07-31", "2026-08-07", "2026-08-14", "2026-08-21", "2026-08-28", "2026-09-04", "2026-09-11", "2026-09-18"];
const drift = (base: number, i: number, amp: number) => (base * (1 + (i - FRIDAYS.length) * 0.004 + Math.sin(i * 1.3) * amp)).toFixed(2);
for (const [i, day] of FRIDAYS.entries()) {
  const [aapl, vti, tencent] = [drift(227.52, i, 0.02), drift(299.85, i, 0.012), drift(505, i, 0.03)];
  const mv = (q: number, p: string) => (q * Number(p)).toFixed(2);
  await writeStatement(db, user, ibkrDay(day, [aapl, vti, tencent], [mv(25, aapl), mv(40, vti), mv(100, tencent)]));
}
await writeStatement(db, user, {
  ...ibkrDay("2026-09-25", ["227.52", "299.85", "505"], ["5688.00", "11994.00", "50500"]),
  transactions: [
    { accountExternalId: "U0000001", securityExternalId: "12345001", externalId: "demo-t1", date: "2026-08-20", type: "buy", quantity: "5", amount: "-1480.25", currency: "USD", description: "Buy 5 VTI", raw: { demo: true } },
    { accountExternalId: "U0000001", securityExternalId: "265598", externalId: "demo-t2", date: "2026-08-14", type: "dividend", quantity: null, amount: "6.50", currency: "USD", description: "AAPL cash dividend", raw: { demo: true } },
    { accountExternalId: "U0000001", securityExternalId: "12345001", externalId: "demo-t3", date: "2026-09-26", type: "dividend", quantity: null, amount: "35.84", currency: "USD", description: "VTI cash dividend", raw: { demo: true } },
    { accountExternalId: "U0000001", securityExternalId: "12345002", externalId: "demo-t4", date: "2026-09-08", type: "dividend", quantity: null, amount: "240", currency: "HKD", description: "700 cash dividend", raw: { demo: true } },
  ],
});
await writeStatement(db, user, ibkrDay("2026-09-28", ["229.87", "301.12", "512.5"], ["5746.75", "12044.80", "51250"]));

// A year of daily NAV in Base (USD) before the weekly closes, as an IBKR history pull leaves it, with the
// deposits and the withdrawal that moved it. Walked back from the first weekly close (HKD at a fixed 0.1283);
// returns are made up.
const NAV_FLOWS = new Map([
  ["2025-11-03", 5000],
  ["2026-02-02", 3000],
  ["2026-05-01", 2000],
  ["2026-06-15", -1000],
]);
const navDays: string[] = [];
for (let t = Date.UTC(2025, 8, 29); t < Date.UTC(2026, 6, 3); t += 86_400_000) {
  const d = new Date(t);
  if (d.getUTCDay() !== 0 && d.getUTCDay() !== 6) navDays.push(d.toISOString().slice(0, 10));
}
const first = FRIDAYS.map((_, i) => [drift(227.52, i, 0.02), drift(299.85, i, 0.012), drift(505, i, 0.03)])[0]!;
let nav = 25 * Number(first[0]) + 40 * Number(first[1]) + 1234.56 + (100 * Number(first[2]) + 500) * 0.1283;
const navRows: { accountExternalId: string; date: string; currency: string; total: string; raw: Record<string, unknown> }[] = [];
for (let k = navDays.length - 1; k >= 0; k--) {
  const day = navDays[k]!;
  navRows.push({ accountExternalId: "U0000001", date: day, currency: "USD", total: nav.toFixed(2), raw: { demo: true } });
  nav = (nav - (NAV_FLOWS.get(day) ?? 0)) / (1 + 0.0006 + Math.sin(k * 0.9) * 0.007);
}
await writeStatement(db, user, {
  ...ibkrDay("2026-09-28", ["229.87", "301.12", "512.5"], ["5746.75", "12044.80", "51250"]),
  navs: navRows.reverse(),
  transactions: [...NAV_FLOWS].map(([date, amount], i) => ({
    accountExternalId: "U0000001",
    securityExternalId: null,
    externalId: `demo-cash-${i + 1}`,
    date,
    type: "transfer" as const,
    quantity: null,
    amount: amount.toFixed(2),
    currency: "USD",
    description: amount > 0 ? "CASH RECEIPTS / ELECTRONIC FUND TRANSFERS" : "DISBURSEMENT",
    raw: { demo: true },
  })),
});

// A Plaid brokerage login as the "Connect a brokerage" flow leaves it (a made-up token in the Plaid format, so the Production pill shows; sync is never called on it).
const brokerage = (await db
  .insert(bankConnections)
  .values({ userId: user.id, provider: "plaid", kind: "brokerage", enrollmentId: "demo-item-brokerage", institutionName: "Robinhood", accessToken: "access-production-demo-not-a-token" })
  .returning({ id: bankConnections.id })
  )[0]!.id;
const plaidDay = (asOf: string, [nvda, voo]: [string, string], values: [string, string]): InvestStatement => ({
  source: "plaid",
  asOf,
  accounts: [{ externalId: "demo-rh-individual", name: "Robinhood Individual 0004", currency: "USD" }],
  securities: [
    { externalId: "demo-sec-nvda", symbol: "NVDA", name: "NVIDIA Corporation", type: "equity", currency: "USD", isin: null, cusip: null, multiplier: null },
    { externalId: "demo-sec-voo", symbol: "VOO", name: "Vanguard S&P 500 ETF", type: "etf", currency: "USD", isin: null, cusip: null, multiplier: null },
  ],
  holdings: [
    holding("demo-rh-individual", "demo-sec-nvda", "USD", "3.52718", nvda, values[0], "512.30"),
    holding("demo-rh-individual", "demo-sec-voo", "USD", "2", voo, values[1], "980.00"),
    holding("demo-rh-individual", null, "USD", "86.12", "1", "86.12", null),
  ],
  transactions: [],
  warnings: [],
});
for (const [i, day] of FRIDAYS.entries()) {
  const [nvda, voo] = [drift(178.9, i, 0.04), drift(548.3, i, 0.01)];
  await writeStatement(db, user, plaidDay(day, [nvda, voo], [(3.52718 * Number(nvda)).toFixed(2), (2 * Number(voo)).toFixed(2)]), { bankConnectionId: brokerage });
}
await writeStatement(db, user, plaidDay("2026-09-25", ["178.90", "548.30"], ["631.01", "1096.60"]), { bankConnectionId: brokerage });
await writeStatement(db, user, plaidDay("2026-09-28", ["181.44", "552.10"], ["639.97", "1104.20"]), { bankConnectionId: brokerage });
await db.update(bankConnections).set({ cursor: "2026-09-28", lastSyncedAt: "2026-09-28T22:15:00.000Z" }).where(eq(bankConnections.id, brokerage));

// ---------- account balances (Assets) ----------
const accountId = async (name: string) =>
  (await db
    .select({ id: accounts.id })
    .from(accounts)
    .where(and(eq(accounts.userId, user.id), eq(accounts.name, name)))
    .limit(1))[0]!.id;
// Wallets, the debit card and the other credit card: a starting balance on Jul 1, then their transactions.
await setStartingBalance(db, user, await accountId("支付宝余额"), { amountMinor: 152430, on: "2026-06-30" });
await setStartingBalance(db, user, await accountId("微信零钱"), { amountMinor: 120460, on: "2026-06-30" });
await setStartingBalance(db, user, await accountId("招商银行储蓄卡 0001"), { amountMinor: 8430000, on: "2026-06-30" });
await setStartingBalance(db, user, await accountId("交通银行信用卡 0002"), { amountMinor: -82000, on: "2026-06-30" });
// The ICBC import wrote the closing balance on Sep 29; earlier monthly statements (Jun 30, Jul 24, Aug 24).
const icbc = files.find(([name]) => name.startsWith("工商银行"))![1];
const icbcCard = await accountId("工商银行信用卡 0003");
for (const day of ["2026-06-30", "2026-07-24", "2026-08-24"]) {
  const bal = icbc.filter((r) => r.occurredAt.slice(0, 10) <= day).reduce((n, r) => n + r.amountMinor, ICBC_OPENING);
  await upsertBalanceSnapshot(db, user, { accountId: icbcCard, asOf: day, balanceMinor: bal, currency: "USD", source: "statement", raw: { demo: true } });
}
// A bank connection as Plaid leaves it (a made-up token in the Plaid format), with its checking balance every few days.
const bank = (await db
  .insert(bankConnections)
  .values({ userId: user.id, provider: "plaid", kind: "bank", enrollmentId: "demo-item-bank", institutionName: "Bank of America", accessToken: "access-production-demo-not-a-token", cursor: "demo", lastSyncedAt: "2026-09-29T18:12:00.000Z" })
  .returning({ id: bankConnections.id })
  )[0]!.id;
const checking = (await db
  .insert(accounts)
  .values({ userId: user.id, name: "Bank of America Adv Plus Banking 5501", kind: "debit_card", institution: "Bank of America", last4: "5501", currency: "USD" })
  .returning({ id: accounts.id })
  )[0]!.id;
await db.insert(bankAccounts)
  .values({ userId: user.id, connectionId: bank, providerAccountId: "demo-chk", accountId: checking, name: "Adv Plus Banking", type: "depository", subtype: "checking", lastFour: "5501", currency: "USD" });
let chk = 480000;
for (let i = 0; i < DAYS.length; i += 3) {
  // Paychecks on the 1st and 15th, card payments on the 25th, small drift in between.
  const day = DAYS[i]!;
  const dom = Number(day.slice(8));
  chk += (dom <= 3 || (dom >= 15 && dom <= 17) ? 310000 : 0) - (dom >= 24 && dom <= 26 ? 175000 : 0) - int(2000, 30000);
  await upsertBalanceSnapshot(db, user, { accountId: checking, asOf: day, balanceMinor: chk, currency: "USD", source: "plaid", raw: { demo: true } });
}
await upsertBalanceSnapshot(db, user, { accountId: checking, asOf: TODAY, balanceMinor: chk + 31240, currency: "USD", source: "plaid", raw: { demo: true } });

const bal = (await balances(db, user))
  .map((b) => `${b.name} ${b.currency} ${formatMinor(b.owedToMeMinor, b.currency)}`)
  .join(", ");
console.log(`demo db ${path.relative(process.cwd(), target)}: ${batchCounts.join(", ")} rows; participants ${roommate.name}, ${xiaoli.name}; balances ${bal}`);
await closeDb(db);
