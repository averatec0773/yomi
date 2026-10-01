import { userSettings } from "@yomi/db";
import { describe, expect, it } from "vitest";
import { freshDb, user } from "../ledger/test-helpers";
import { getPaymentMethods, getProfileContact, setPaymentMethods, setProfileContact } from "./payment";
import { readSetting, writeSetting } from "./store";

const none = { email: null, phone: null, username: null, text: null };
const noFlags = { useProfileEmail: false, useProfilePhone: false };

describe("payment methods storage", () => {
  it("round-trips the list as one JSON value and removes the row when empty", async () => {
    const db = await freshDb();
    expect(await getPaymentMethods(db, user)).toEqual([]);
    const zelle = {
      kind: "zelle" as const,
      label: "Zelle (Chase)",
      ...none,
      email: "alex@example.com",
      phone: "+1 555 010 0100",
      ...noFlags,
      qr: null,
      original: null,
      display: "clean" as const,
      currencies: ["USD"],
      showOnStatement: true,
    };
    expect(await setPaymentMethods(db, user, [zelle])).toEqual([zelle]);
    // Saved with the flags, so it is never taken for a value from before v0.1.29: the profile stays empty.
    expect(await getProfileContact(db, user)).toEqual({ email: null, phone: null });
    expect((await db.select().from(userSettings)).filter((r) => r.key === "payment_methods")).toHaveLength(1);
    expect(await setPaymentMethods(db, user, [])).toEqual([]);
    expect((await db.select().from(userSettings)).some((r) => r.key === "payment_methods")).toBe(false);
  });

  it("reads a hand-edited value leniently: unknown kinds and empty entries are skipped, currencies default", async () => {
    const db = await freshDb();
    const venmo = { kind: "venmo", username: "@alex-demo" };
    await writeSetting(
      db,
      user,
      "payment_methods",
      JSON.stringify([{ kind: "bitcoin", text: "x" }, { kind: "wechat", text: "" }, { kind: "alipay", text: " alex-demo " }, ...Array(8).fill(venmo)]),
    );
    const read = await getPaymentMethods(db, user);
    expect(read).toHaveLength(6);
    expect(read[0]).toEqual({
      kind: "alipay",
      label: null,
      ...none,
      text: "alex-demo",
      ...noFlags,
      qr: null,
      original: null,
      display: "clean",
      currencies: ["CNY"],
      showOnStatement: true,
    });
    await writeSetting(db, user, "payment_methods", "not json");
    expect(await getPaymentMethods(db, user)).toEqual([]);
  });

  it("upgrades values saved with one `handle` (v0.1.25) without losing any, and writes the new shape back", async () => {
    const db = await freshDb();
    const old = [
      { kind: "zelle", label: "Zelle (Chase)", handle: "alex@example.com", qr: null, currencies: ["USD"], showOnStatement: true },
      { kind: "zelle", label: null, handle: "+1 555 0100", qr: "https://example.com/qr/alex-demo", currencies: ["USD"], showOnStatement: true },
      { kind: "zelle", label: null, handle: "alexdemo", qr: null, currencies: ["USD"], showOnStatement: false },
      { kind: "venmo", label: null, handle: "@alex-demo", qr: null, currencies: ["USD"], showOnStatement: true },
      { kind: "paypal", label: null, handle: "alex@example.com", qr: null, currencies: ["USD"], showOnStatement: true },
      { kind: "wechat", label: null, handle: "alex@example.com", qr: null, currencies: ["CNY"], showOnStatement: true },
    ];
    await writeSetting(db, user, "payment_methods", JSON.stringify(old));
    const read = await getPaymentMethods(db, user);
    // The email and phone moved to the profile (v0.1.29), and the methods that had them now use it.
    expect(await getProfileContact(db, user)).toEqual({ email: "alex@example.com", phone: "+1 555 0100" });
    expect(read.map(({ kind, email, phone, username, text, useProfileEmail, useProfilePhone }) => ({ kind, email, phone, username, text, useProfileEmail, useProfilePhone }))).toEqual([
      { kind: "zelle", ...none, useProfileEmail: true, useProfilePhone: false },
      { kind: "zelle", ...none, useProfileEmail: false, useProfilePhone: true },
      { kind: "zelle", ...none, text: "alexdemo", ...noFlags },
      { kind: "venmo", ...none, username: "@alex-demo", ...noFlags },
      { kind: "paypal", ...none, useProfileEmail: true, useProfilePhone: false },
      { kind: "wechat", ...none, text: "alex@example.com", ...noFlags },
    ]);
    // Everything else stays as it was.
    expect(read.map((m) => [m.label, m.qr, m.currencies, m.showOnStatement])).toEqual(old.map((m) => [m.label, m.qr, m.currencies, m.showOnStatement]));
    // Written back at once, without `handle`; reading again changes nothing.
    const stored = JSON.parse((await readSetting(db, user, "payment_methods"))!) as Record<string, unknown>[];
    expect(stored.some((m) => "handle" in m)).toBe(false);
    expect(stored[0]).toMatchObject({ kind: "zelle", email: null, phone: null, useProfileEmail: true, useProfilePhone: false });
    expect(await getPaymentMethods(db, user)).toEqual(read);
    await setPaymentMethods(db, user, read);
    expect(await getPaymentMethods(db, user)).toEqual(read);
  });

  it("a new field wins over a stale handle", async () => {
    const db = await freshDb();
    await writeSetting(db, user, "payment_methods", JSON.stringify([{ kind: "zelle", handle: "old@example.com", phone: "+1 555 010 0100" }]));
    expect((await getPaymentMethods(db, user))[0]).toMatchObject({ ...none, useProfilePhone: true });
    expect(await getProfileContact(db, user)).toEqual({ email: null, phone: "+1 555 010 0100" });
  });

  it("v0.1.29: a stored Zelle method ends up referencing the profile, once, whichever is read first", async () => {
    const zelle = { kind: "zelle", label: "Zelle (Chase)", email: "alex@example.com", phone: "+1 555 010 0100", qr: null, currencies: ["USD"], showOnStatement: true };
    const other = { kind: "paypal", label: null, username: "alexdemo", email: "alex.work@example.com", qr: null, currencies: ["USD"], showOnStatement: true };
    const db = await freshDb();
    await writeSetting(db, user, "payment_methods", JSON.stringify([zelle, other]));
    // Reading the profile runs the upgrade too, and writes both back.
    expect(await getProfileContact(db, user)).toEqual({ email: "alex@example.com", phone: "+1 555 010 0100" });
    expect(await readSetting(db, user, "profile_email")).toBe("alex@example.com");
    const stored = JSON.parse((await readSetting(db, user, "payment_methods"))!) as Record<string, unknown>[];
    expect(stored.map((m) => [m.email, m.phone, m.useProfileEmail, m.useProfilePhone])).toEqual([
      [null, null, true, true],
      ["alex.work@example.com", null, false, false],
    ]);
    // Clearing the profile later does not bring the old value back.
    expect(await setProfileContact(db, user, { email: null })).toEqual({ email: null, phone: "+1 555 010 0100" });
    expect((await getPaymentMethods(db, user))[0]).toMatchObject({ email: null, useProfileEmail: true });
    expect(await getProfileContact(db, user)).toEqual({ email: null, phone: "+1 555 010 0100" });
  });

  it("v0.1.30: phones typed before read as E.164, are written back on the next save only, and unreadable ones stay as typed", async () => {
    const db = await freshDb();
    await writeSetting(db, user, "profile_phone", "(202) 555-0143");
    const method = { kind: "zelle", label: null, ...none, phone: "+86 138 0013 8000", ...noFlags, qr: null, currencies: ["USD"], showOnStatement: true };
    const odd = { ...method, kind: "other", label: "Bank", phone: "13800138000", text: "Account 42" };
    await writeSetting(db, user, "payment_methods", JSON.stringify([method, odd]));
    expect((await getProfileContact(db, user)).phone).toBe("+12025550143");
    expect((await getPaymentMethods(db, user)).map((m) => m.phone)).toEqual(["+8613800138000", "13800138000"]);
    // Reading changes nothing stored.
    expect(await readSetting(db, user, "profile_phone")).toBe("(202) 555-0143");
    expect(await readSetting(db, user, "payment_methods")).toContain('"+86 138 0013 8000"');
    // The next save writes the upgraded values; a value that is not a valid number is kept as typed.
    await setProfileContact(db, user, { email: "alex@example.com" });
    expect(await readSetting(db, user, "profile_phone")).toBe("+12025550143");
    await setPaymentMethods(db, user, await getPaymentMethods(db, user));
    expect((JSON.parse((await readSetting(db, user, "payment_methods"))!) as { phone: string }[]).map((m) => m.phone)).toEqual(["+8613800138000", "13800138000"]);
  });

  it("profile contact: trimmed, only the fields given change, empty removes the row", async () => {
    const db = await freshDb();
    expect(await setProfileContact(db, user, { email: " alex@example.com " })).toEqual({ email: "alex@example.com", phone: null });
    expect(await setProfileContact(db, user, { phone: "+1 555 010 0100" })).toEqual({ email: "alex@example.com", phone: "+1 555 010 0100" });
    expect(await setProfileContact(db, user, { email: "" })).toEqual({ email: null, phone: "+1 555 010 0100" });
    expect((await db.select().from(userSettings)).some((r) => r.key === "profile_email")).toBe(false);
  });

  it("a flag is kept only for a field the kind shows, and only while the method has no own value there", async () => {
    const db = await freshDb();
    await writeSetting(
      db,
      user,
      "payment_methods",
      JSON.stringify([
        { kind: "venmo", username: "@alex-demo", useProfileEmail: true, useProfilePhone: true },
        { kind: "zelle", email: "alex.work@example.com", useProfileEmail: true, useProfilePhone: true },
        { kind: "zelle", useProfileEmail: false, useProfilePhone: false },
      ]),
    );
    expect((await getPaymentMethods(db, user)).map((m) => [m.kind, m.email, m.useProfileEmail, m.useProfilePhone])).toEqual([
      ["venmo", null, true, false],
      ["zelle", "alex.work@example.com", false, true],
    ]);
  });

  it("keeps the original QR image beside its payload; values saved before v0.1.27 read as clean", async () => {
    const db = await freshDb();
    const qr = "https://example.com/qr/alex-demo";
    const original = { dataUrl: "data:image/webp;base64,UklGRg==", width: 300, height: 360 };
    await writeSetting(
      db,
      user,
      "payment_methods",
      JSON.stringify([
        // v0.1.26: no display, no original.
        { kind: "zelle", qr, currencies: ["USD"], showOnStatement: true },
        { kind: "zelle", qr, original, display: "original" },
        // Kept while clean, so switching back needs no new import.
        { kind: "zelle", qr, original, display: "clean" },
        // "original" without a usable image reads as clean.
        { kind: "zelle", qr, display: "original" },
        { kind: "zelle", qr, original: { ...original, dataUrl: "data:image/svg+xml;base64,PHN2Zz4=" }, display: "original" },
        { kind: "zelle", qr, original: { ...original, width: 1200 }, display: "original" },
      ]),
    );
    expect((await getPaymentMethods(db, user)).map((m) => [m.display, m.original])).toEqual([
      ["clean", null],
      ["original", original],
      ["clean", original],
      ["clean", null],
      ["clean", null],
      ["clean", null],
    ]);
    // An original without its QR payload is dropped; the method stays for its email.
    await writeSetting(db, user, "payment_methods", JSON.stringify([{ kind: "zelle", email: "alex@example.com", original, display: "original" }]));
    expect((await getPaymentMethods(db, user))[0]).toMatchObject({ useProfileEmail: true, original: null, display: "clean" });
  });
});
