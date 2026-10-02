// English-only demo ledger for README screenshots: `pnpm demo:showcase [dir]` (default data/demo-showcase-pglite).
// A US checking account (5501) and credit card (3141), two roommates and a friend, July to September 2026.
// Every name, merchant, card number and amount is made up. The e2e suite uses `pnpm demo:db`, not this ledger.
import path from "node:path";
import { and, eq } from "@yomi/db/orm";
import { accounts, closeDb, createDb, migrate } from "@yomi/db";
import { bucketTotals, type NormalizedRow, type ParseResult } from "@yomi/importers";
import {
  type AccountSpec,
  commitParsed,
  createFriendPaidExpense,
  createParticipant,
  createQuickEntry,
  getCurrentUser,
  listCategories,
  listTransactions,
  markAsSettlement,
  seed,
  setCategory,
  setMonthlyTarget,
  setSplit,
  setStartingBalance,
  sha256Hex,
  updateTransaction,
} from "../index";
import { prepareDemoDir } from "./demo-dir";

const target = prepareDemoDir(process.argv[2], "data/demo-showcase-pglite");

// ---------- deterministic randomness ----------
let state = 20260930;
function rnd(): number {
  state = (state + 0x6d2b79f5) | 0;
  let t = state;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}
const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rnd() * xs.length)]!;
const cents = (lo: number, hi: number) => Math.round((lo + rnd() * (hi - lo)) * 100);

const TODAY = "2026-09-29";
/** Random rows stop before the last few days, which are written by hand so the newest screen reads well. */
const RANDOM_UNTIL = "2026-09-24";
const DAYS = Array.from({ length: 86 }, (_, i) => new Date(Date.UTC(2026, 6, 1) + i * 86_400_000).toISOString().slice(0, 10));
if (DAYS.at(-1) !== RANDOM_UNTIL) throw new Error("showcase day range is off");
const randomDay = () => pick(DAYS);
const MONTHS = ["07", "08", "09"] as const;
/** BoA files carry dates only; the importer stores them at noon US Eastern standard time. */
const at = (day: string) => `${day}T12:00:00-05:00`;
const usDate = (day: string) => `${day.slice(5, 7)}/${day.slice(8, 10)}/${day.slice(0, 4)}`;
const dollars = (minor: number) => `${minor < 0 ? "-" : ""}${(Math.abs(minor) / 100).toFixed(2)}`;

// ---------- rows ----------
const CARD: AccountSpec = { name: "Bank of America 信用卡 3141", kind: "credit_card", institution: "Bank of America", last4: "3141", currency: "USD" };
const CHECKING: AccountSpec = { name: "Bank of America 支票 5501", kind: "debit_card", institution: "Bank of America", last4: "5501", currency: "USD" };

interface Draft {
  day: string;
  amountMinor: number;
  kind: NormalizedRow["kind"];
  counterparty: string;
  description: string;
  sourceCategory: string | null;
  tag?: string;
}

const tagged = new Map<string, Draft[]>();
function tag(d: Draft): Draft {
  if (d.tag) tagged.set(d.tag, [...(tagged.get(d.tag) ?? []), d]);
  return d;
}

const card: Draft[] = [];
const spend = (day: string, counterparty: string, address: string, minor: number, t?: string) =>
  card.push(tag({ day, amountMinor: -minor, kind: "expense", counterparty, description: `${counterparty} ${address}`, sourceCategory: "Purchase", tag: t }));

const GROCERS: [string, string, number, number][] = [
  ["TRADER JOE'S #552", "AUSTIN TX", 28, 95],
  ["H-E-B #418", "AUSTIN TX", 22, 110],
  ["WHOLE FOODS MARKET #10234", "AUSTIN TX", 30, 120],
  ["COSTCO WHOLESALE #681", "AUSTIN TX", 90, 210],
];
const RESTAURANTS: [string, number, number][] = [
  ["TST*ROSIE'S TACO BAR", 14, 32],
  ["TST*LITTLE ITALY PIZZA", 18, 40],
  ["SAKURA SUSHI", 24, 58],
  ["BLUE DOOR BISTRO", 26, 64],
];
for (let i = 0; i < 26; i++) {
  const [name, city, lo, hi] = pick(GROCERS);
  spend(randomDay(), name, city, cents(lo, hi), "grocery");
}
for (let i = 0; i < 30; i++) spend(randomDay(), "SQ *MERIDIAN COFFEE", "AUSTIN TX", cents(4.5, 9.5));
for (let i = 0; i < 16; i++) spend(randomDay(), "UBER *TRIP", "SAN FRANCISCO CA", cents(9, 31));
for (let i = 0; i < 8; i++) spend(randomDay(), "LYFT *RIDE", "SAN FRANCISCO CA", cents(8, 26));
for (let i = 0; i < 14; i++) {
  const [name, lo, hi] = pick(RESTAURANTS);
  spend(randomDay(), name, "AUSTIN TX", cents(lo, hi));
}
for (let i = 0; i < 9; i++) spend(randomDay(), "AMAZON MKTPL*2K4AB1", "AMZN.COM/BILL WA", cents(11, 79));
for (let i = 0; i < 4; i++) spend(randomDay(), "TARGET 00012345", "AUSTIN TX", cents(15, 70));
spend("2026-08-19", "WALGREENS #07210", "AUSTIN TX", 2384);
for (const m of MONTHS) {
  spend(`2026-${m}-07`, "NETFLIX", "NETFLIX.COM CA", 1549);
  spend(`2026-${m}-12`, "SPOTIFY", "SPOTIFY.COM NY", 1199);
}
// Dinners out with the roommates and a friend.
spend("2026-07-18", "HILLSIDE GRILL", "AUSTIN TX", 9615, "dinner");
spend("2026-08-22", "SAKURA SUSHI", "AUSTIN TX", 11840, "dinner");
spend("2026-09-12", "BLUE DOOR BISTRO", "AUSTIN TX", 8730, "dinner");
// The last days of the month, by hand.
spend("2026-09-29", "TRADER JOE'S #552", "AUSTIN TX", 6427, "grocery_last");
spend("2026-09-29", "UBER *TRIP", "SAN FRANCISCO CA", 1840);
spend("2026-09-29", "SQ *MERIDIAN COFFEE", "AUSTIN TX", 675);
spend("2026-09-28", "HILLSIDE GRILL", "AUSTIN TX", 14280, "birthday");
spend("2026-09-28", "LYFT *RIDE", "SAN FRANCISCO CA", 1420);
spend("2026-09-27", "H-E-B #418", "AUSTIN TX", 3812);
spend("2026-09-27", "TST*ROSIE'S TACO BAR", "AUSTIN TX", 1865);
spend("2026-09-26", "COSTCO WHOLESALE #681", "AUSTIN TX", 18764, "grocery_last");
spend("2026-09-26", "TARGET 00012345", "AUSTIN TX", 2749);
spend("2026-09-25", "AMAZON MKTPL*2K4AB1", "AMZN.COM/BILL WA", 4299);
// For Analysis: coffee for the team (larger than usual) and a first purchase at a new store (first large).
spend("2026-09-28", "SQ *MERIDIAN COFFEE", "AUSTIN TX", 3460);
spend("2026-09-24", "BRIGHT SCREENS ELECTRONICS", "AUSTIN TX", 64900);
// Card payments from checking, the month after each statement.
const payments = [["2026-07-25", 118240], ["2026-08-25", 131575], ["2026-09-25", 127310]] as const;
for (const [day, minor] of payments) {
  card.push({ day, amountMinor: minor, kind: "transfer", counterparty: "Bank of America", description: "PAYMENT - THANK YOU", sourceCategory: "Transfer" });
}

const checking: Draft[] = [];
const ach = (day: string, company: string, des: string, minor: number, kind: Draft["kind"], sourceCategory: string, t?: string) =>
  checking.push(tag({ day, amountMinor: minor, kind, counterparty: company, description: `${company} DES:${des} ID:${day.replace(/-/g, "")} CO ID:9000123456 PPD`, sourceCategory, tag: t }));
for (const m of MONTHS) {
  ach(`2026-${m}-01`, "PARKSIDE APTS", "WEB PMTS", -285000, "expense", "ACH", "rent");
  ach(`2026-${m}-08`, "AUSTIN ENERGY", "UTIL PYMT", -cents(92, 138), "expense", "ACH", "utility");
  ach(`2026-${m}-18`, "T-MOBILE", "PCS SVC", -4500, "expense", "ACH", "phone");
  ach(`2026-${m}-15`, "NORTHWIND LABS", "PAYROLL", 324000, "income", "Payroll");
}
ach("2026-07-31", "NORTHWIND LABS", "PAYROLL", 324000, "income", "Payroll");
ach("2026-08-31", "NORTHWIND LABS", "PAYROLL", 324000, "income", "Payroll");
for (const [day, minor] of payments) {
  checking.push({ day, amountMinor: -minor, kind: "transfer", counterparty: "Credit card 3141", description: "Online Banking payment to CRD 3141", sourceCategory: "Transfer" });
}
// Roommates paying back their share over Zelle.
const zelle = (day: string, name: string, minor: number, conf: string, t: string) =>
  checking.push(tag({ day, amountMinor: minor, kind: "income", counterparty: name, description: `Zelle payment from ${name} Conf# ${conf}`, sourceCategory: "Zelle", tag: t }));
zelle("2026-08-03", "SAM", 104260, "b4kq8zr2m", "settle_sam");
zelle("2026-09-27", "ALEX", 112350, "t7pw3xn9d", "settle_alex");

// ---------- import ----------
function rows(drafts: Draft[], kind: "card" | "checking"): NormalizedRow[] {
  drafts.sort((a, b) => a.day.localeCompare(b.day));
  let balance = 620000;
  return drafts.map((d, i): NormalizedRow => {
    balance += d.amountMinor;
    const ref = `2446${d.day.replace(/-/g, "")}${String(i).padStart(9, "0")}`;
    return {
      source: "boa_csv",
      lineNo: i + 1,
      externalId: kind === "card" ? ref : null,
      occurredAt: at(d.day),
      amountMinor: d.amountMinor,
      currency: "USD",
      originalAmountMinor: null,
      originalCurrency: null,
      direction: d.amountMinor < 0 ? "out" : "in",
      kind: d.kind,
      status: "ok",
      counterparty: d.counterparty,
      description: d.description,
      sourceCategory: d.sourceCategory,
      paymentMethod: kind === "card" ? "Bank of America 信用卡" : "Bank of America 支票",
      raw:
        kind === "card"
          ? { "Posted Date": usDate(d.day), "Reference Number": ref, Payee: d.counterparty, Address: d.description, Amount: dollars(d.amountMinor) }
          : { Date: usDate(d.day), Description: d.description, Amount: dollars(d.amountMinor), "Running Bal.": dollars(balance) },
    };
  });
}

const db = await createDb(target);
await migrate(db);
await seed(db);
const user = getCurrentUser();

const files: [string, NormalizedRow[], AccountSpec][] = [
  ["stmt-checking-5501.csv", rows(checking, "checking"), CHECKING],
  ["stmt-card-3141.csv", rows(card, "card"), CARD],
];
const counts: string[] = [];
for (const [fileName, fileRows, spec] of files) {
  const parsed: ParseResult = { source: "boa_csv", rows: fileRows, declared: bucketTotals(fileRows), periodStart: "2026-07-01", periodEnd: TODAY, warnings: [] };
  const r = await commitParsed(db, user, parsed, {
    fileHash: sha256Hex(`showcase:${fileName}:${JSON.stringify(fileRows)}`),
    fileName,
    backup: false,
    accountSpec: () => spec,
  });
  if (!r.reconciliation.ok) throw new Error(`${fileName}: reconciliation failed`);
  counts.push(`${fileName} ${r.inserted}`);
}

const keyOf = (r: { occurredAt: string; amountMinor: number; counterparty: string }) => `${r.occurredAt}|${r.amountMinor}|${r.counterparty}`;
const idByKey = new Map(
  (await listTransactions(db, user, { limit: 5000 })).items.map((t) => [keyOf({ occurredAt: t.occurredAt, amountMinor: t.amountMinor, counterparty: t.counterpartyRaw }), t.id]),
);
const ids = (t: string) =>
  (tagged.get(t) ?? []).map((d) => {
    const id = idByKey.get(keyOf({ occurredAt: at(d.day), amountMinor: d.amountMinor, counterparty: d.counterparty }));
    if (id === undefined) throw new Error(`showcase row not found after import: ${d.day} ${d.counterparty}`);
    return id;
  });
const one = (t: string) => ids(t)[0]!;

const cats = new Map((await listCategories(db, user)).map((c) => [c.name, c.id]));
const housing = cats.get("居住")!;
for (const t of ["rent", "utility", "phone"]) await setCategory(db, user, one(t), housing, { applyToMerchant: true });

const alex = await createParticipant(db, user, "Alex", [{ kind: "zelle_name", value: "ALEX" }]);
const sam = await createParticipant(db, user, "Sam", [{ kind: "zelle_name", value: "SAM" }]);
const jordan = await createParticipant(db, user, "Jordan");
const roommates = [alex.id, sam.id];

for (const id of [...ids("rent"), ...ids("utility")]) await setSplit(db, user, id, { participantIds: roommates, mode: "equal" });
for (const id of [...ids("grocery").filter(() => rnd() < 0.7), ...ids("grocery_last")]) {
  await setSplit(db, user, id, { participantIds: roommates, mode: "equal" });
}
for (const id of ids("dinner")) await setSplit(db, user, id, { participantIds: [...roommates, jordan.id], mode: "equal" });
await setSplit(db, user, one("birthday"), { participantIds: [alex.id, jordan.id], mode: "equal" });
await updateTransaction(db, user, one("birthday"), { note: "Sam's birthday dinner" });

await createFriendPaidExpense(db, user, { payerId: sam.id, totalMinor: 7499, currency: "USD", occurredAt: "2026-08-04", description: "Internet (Aug)", categoryId: housing });
await createFriendPaidExpense(db, user, { payerId: sam.id, totalMinor: 7499, currency: "USD", occurredAt: "2026-09-04", description: "Internet (Sep)", categoryId: housing });
await createFriendPaidExpense(db, user, { payerId: alex.id, totalMinor: 3600, currency: "USD", occurredAt: "2026-09-26", description: "Pizza night", categoryId: cats.get("餐饮")! });
await createQuickEntry(db, user, { amountMinor: 1850, currency: "USD", description: "Farmers market", date: "2026-09-20", participantIds: [], payerId: null, mode: "equal", categoryHint: "买菜" });
await createQuickEntry(db, user, { amountMinor: 3200, currency: "USD", description: "Paper towels and detergent", date: "2026-09-21", participantIds: roommates, payerId: null, mode: "equal", categoryHint: "日用" });

await markAsSettlement(db, user, one("settle_sam"), { participantId: sam.id });
await markAsSettlement(db, user, one("settle_alex"), { participantId: alex.id });

await setMonthlyTarget(db, user, { month: null, amountMinor: 300000, currency: "USD" });
const accountId = async (name: string) =>
  (await db.select({ id: accounts.id }).from(accounts).where(and(eq(accounts.userId, user.id), eq(accounts.name, name))).limit(1))[0]!.id;
await setStartingBalance(db, user, await accountId(CHECKING.name), { amountMinor: 620000, on: "2026-06-30" });
await setStartingBalance(db, user, await accountId(CARD.name), { amountMinor: -118240, on: "2026-06-30" });

console.log(`showcase db ${path.relative(process.cwd(), target)}: ${counts.join(", ")}; participants Alex, Sam, Jordan`);
await closeDb(db);
