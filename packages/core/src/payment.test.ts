import { describe, expect, it } from "vitest";
import {
  contactParts,
  defaultProfileFlags,
  hasRequiredContact,
  linkText,
  looksLikeEmail,
  looksLikePhone,
  methodsForCurrency,
  type PaymentMethod,
  paymentFields,
  paymentLink,
  paymentSlug,
  paymentTitle,
  profileFields,
  resolveContact,
  sameContact,
  type StoredPaymentMethod,
  statementPayments,
  upgradeHandle,
  upgradeToProfile,
} from "./payment";

const method = (m: Partial<PaymentMethod> & Pick<PaymentMethod, "kind">): PaymentMethod => ({
  label: null,
  email: null,
  phone: null,
  username: null,
  text: null,
  useProfileEmail: false,
  useProfilePhone: false,
  qr: null,
  original: null,
  display: "clean",
  currencies: ["USD"],
  showOnStatement: true,
  ...m,
});
const usd = (minor: number) => ({ minor, currency: "USD" });
const none = { email: null, phone: null, username: null, text: null };

describe("payment links", () => {
  it("Venmo: a profile link from the username, never an amount", () => {
    expect(paymentLink(method({ kind: "venmo", username: "@alex-demo" }), usd(2550))).toBe("https://venmo.com/u/alex-demo");
    expect(paymentLink(method({ kind: "venmo", username: "https://venmo.com/u/alex-demo" }))).toBe("https://venmo.com/u/alex-demo");
    expect(paymentLink(method({ kind: "venmo", username: "venmo.com/alex-demo?txn=pay" }))).toBe("https://venmo.com/u/alex-demo");
    // The optional email never becomes the link.
    expect(paymentLink(method({ kind: "venmo", email: "alex@example.com" }))).toBeNull();
  });

  it("PayPal.me and Cash App: the amount when there is one", () => {
    expect(paymentLink(method({ kind: "paypal", username: "alexdemo" }))).toBe("https://paypal.me/alexdemo");
    expect(paymentLink(method({ kind: "paypal", username: "paypal.me/alexdemo" }), usd(2550))).toBe("https://paypal.me/alexdemo/25.50USD");
    expect(paymentLink(method({ kind: "paypal", username: "alexdemo" }), { minor: 1200, currency: "EUR" })).toBe("https://paypal.me/alexdemo/12.00EUR");
    expect(paymentLink(method({ kind: "cashapp", username: "$alexdemo" }), usd(2550))).toBe("https://cash.app/$alexdemo/25.50");
    expect(paymentLink(method({ kind: "cashapp", username: "https://cash.app/$alexdemo" }))).toBe("https://cash.app/$alexdemo");
    // Cash App amounts are dollars only; a zero or negative amount is left out.
    expect(paymentLink(method({ kind: "cashapp", username: "alexdemo" }), { minor: 2550, currency: "CNY" })).toBe("https://cash.app/$alexdemo");
    expect(paymentLink(method({ kind: "paypal", username: "alexdemo" }), usd(-100))).toBe("https://paypal.me/alexdemo");
  });

  it("Zelle, Alipay and WeChat get no built link; a web link as text is used as is", () => {
    expect(paymentLink(method({ kind: "zelle", email: "alex@example.com" }), usd(100))).toBeNull();
    expect(paymentLink(method({ kind: "zelle", phone: "+1 555 0100" }))).toBeNull();
    expect(paymentLink(method({ kind: "alipay", text: "alex-demo" }))).toBeNull();
    expect(paymentLink(method({ kind: "other", text: "https://example.com/pay/alex-demo" }))).toBe("https://example.com/pay/alex-demo");
    expect(paymentLink(method({ kind: "wechat", text: "https://example.com/wx" }))).toBe("https://example.com/wx");
  });

  it("rejects usernames that are not usernames", () => {
    expect(paymentSlug("venmo", "alex demo")).toBeNull();
    expect(paymentSlug("paypal", "")).toBeNull();
    expect(paymentSlug("zelle", "alex")).toBeNull();
    expect(paymentLink(method({ kind: "venmo", username: "alex demo" }))).toBeNull();
  });

  it("titles and link text", () => {
    expect(paymentTitle("zelle", "Zelle", null)).toBe("Zelle");
    expect(paymentTitle("zelle", "Zelle", "Zelle (Chase)")).toBe("Zelle (Chase)");
    expect(paymentTitle("zelle", "Zelle", "Joint account")).toBe("Zelle · Joint account");
    expect(paymentTitle("other", "Other", "Bank transfer")).toBe("Bank transfer");
    expect(paymentTitle("other", "Other", null)).toBe("Other");
    expect(linkText("https://venmo.com/u/alex-demo/")).toBe("venmo.com/u/alex-demo");
  });
});

describe("contact fields", () => {
  it("per kind: the method's own fields, the profile values it can show, and what it needs", () => {
    expect(paymentFields("zelle")).toEqual([]);
    for (const kind of ["venmo", "paypal", "cashapp"] as const) expect(paymentFields(kind)).toEqual(["username"]);
    for (const kind of ["alipay", "wechat", "other"] as const) expect(paymentFields(kind)).toEqual(["text"]);
    expect(profileFields("zelle")).toEqual(["email", "phone"]);
    for (const kind of ["venmo", "paypal", "cashapp"] as const) expect(profileFields(kind)).toEqual(["email"]);
    for (const kind of ["alipay", "wechat"] as const) expect(profileFields(kind)).toEqual(["phone", "email"]);
    expect(profileFields("other")).toEqual(["email", "phone"]);
    expect(defaultProfileFlags("zelle")).toEqual({ useProfileEmail: true, useProfilePhone: true });
    expect(defaultProfileFlags("paypal")).toEqual({ useProfileEmail: false, useProfilePhone: false });
    expect(hasRequiredContact(method({ kind: "zelle", phone: "+1 555 010 0100" }))).toBe(true);
    expect(hasRequiredContact(method({ kind: "zelle", text: "alexdemo" }))).toBe(false);
    expect(hasRequiredContact(method({ kind: "venmo", email: "alex@example.com" }))).toBe(false);
    expect(hasRequiredContact(method({ kind: "venmo", email: "alex@example.com", qr: "https://example.com/qr" }))).toBe(true);
    expect(hasRequiredContact(method({ kind: "wechat" }))).toBe(false);
    expect(hasRequiredContact(method({ kind: "wechat", text: "alex-demo" }))).toBe(true);
    expect(hasRequiredContact(method({ kind: "alipay", phone: "+86 138 0013 8000" }))).toBe(true);
    expect(hasRequiredContact(method({ kind: "other", email: "alex@example.com" }))).toBe(true);
  });

  it("resolves email and phone: the method's own value wins, else the profile's when the method uses it and its kind shows it", () => {
    const profile = { email: "alex@example.com", phone: "+1 555 010 0100" };
    expect(resolveContact(method({ kind: "zelle", useProfileEmail: true, useProfilePhone: true }), profile)).toEqual({ ...none, ...profile });
    expect(resolveContact(method({ kind: "zelle", useProfileEmail: true }), profile)).toEqual({ ...none, email: "alex@example.com" });
    // An override wins over the profile, per field.
    expect(resolveContact(method({ kind: "zelle", email: "alex.work@example.com", useProfilePhone: true }), profile)).toEqual({
      ...none,
      email: "alex.work@example.com",
      phone: "+1 555 010 0100",
    });
    // Venmo shows no phone, even with the flag set by hand; the username stays the method's own.
    expect(resolveContact(method({ kind: "venmo", username: "@alex-demo", useProfileEmail: true, useProfilePhone: true }), profile)).toEqual({
      ...none,
      username: "@alex-demo",
      email: "alex@example.com",
    });
    // An empty profile shows nothing for the flag.
    expect(resolveContact(method({ kind: "zelle", useProfileEmail: true }), { email: null, phone: null })).toEqual(none);
  });

  it("recognizes emails and phones the way the contract checks them", () => {
    expect(looksLikeEmail(" alex@example.com ")).toBe(true);
    expect(looksLikeEmail("@alex-demo")).toBe(false);
    expect(looksLikeEmail("alex@example")).toBe(false);
    expect(looksLikePhone("+1 555 0100")).toBe(true);
    expect(looksLikePhone("(555) 010-0100")).toBe(true);
    expect(looksLikePhone("555 01")).toBe(false);
    expect(looksLikePhone("$alexdemo")).toBe(false);
  });

  it("upgrades an old single handle to the field its kind shows", () => {
    expect(upgradeHandle("zelle", " alex@example.com ")).toEqual({ ...none, email: "alex@example.com" });
    expect(upgradeHandle("zelle", "+1 555 0100")).toEqual({ ...none, phone: "+1 555 0100" });
    expect(upgradeHandle("zelle", "alexdemo")).toEqual({ ...none, text: "alexdemo" });
    expect(upgradeHandle("venmo", "@alex-demo")).toEqual({ ...none, username: "@alex-demo" });
    expect(upgradeHandle("paypal", "alex@example.com")).toEqual({ ...none, email: "alex@example.com" });
    expect(upgradeHandle("cashapp", "$alexdemo")).toEqual({ ...none, username: "$alexdemo" });
    expect(upgradeHandle("cashapp", "5550100100")).toEqual({ ...none, username: "5550100100" });
    expect(upgradeHandle("alipay", "alex@example.com")).toEqual({ ...none, text: "alex@example.com" });
    expect(upgradeHandle("wechat", "alex-demo")).toEqual({ ...none, text: "alex-demo" });
    expect(upgradeHandle("other", "https://example.com/pay/alex-demo")).toEqual({ ...none, text: "https://example.com/pay/alex-demo" });
    expect(upgradeHandle("zelle", "  ")).toEqual(none);
  });

  it("lists the values for the text export: email, formatted phone, username, text, then a new link", () => {
    expect(contactParts({ ...none, email: "alex@example.com", phone: "+12025550143", link: null })).toEqual(["alex@example.com", "202-555-0143"]);
    // A US number on a statement in another currency carries +1; China is always international.
    expect(contactParts({ ...none, phone: "+12025550143", link: null }, "CNY")).toEqual(["+1 202-555-0143"]);
    expect(contactParts({ ...none, phone: "+8613800138000", link: null }, "USD")).toEqual(["+86 138 0013 8000"]);
    expect(contactParts({ ...none, username: "alexdemo", link: "https://paypal.me/alexdemo" })).toEqual(["alexdemo", "https://paypal.me/alexdemo"]);
    expect(contactParts({ ...none, text: "https://example.com/pay", link: "https://example.com/pay" })).toEqual(["https://example.com/pay"]);
    expect(contactParts({ ...none, link: null })).toEqual([]);
  });
});

describe("methods on a statement", () => {
  const list = [
    method({ kind: "zelle", email: "alex@example.com", phone: "+1 555 010 0100", label: "Zelle (Chase)" }),
    method({ kind: "wechat", text: "alex-demo", currencies: ["CNY"] }),
    method({ kind: "venmo", username: "@alex-demo", showOnStatement: false }),
    method({ kind: "paypal", username: "alexdemo", currencies: ["USD", "CNY"] }),
    method({ kind: "zelle", qr: "https://example.com/qr/alex-demo" }),
  ];

  it("keeps the ones switched on for the currency, in order", () => {
    expect(methodsForCurrency(list, "USD").map((m) => m.kind)).toEqual(["zelle", "paypal", "zelle"]);
    expect(methodsForCurrency(list, "CNY").map((m) => m.kind)).toEqual(["wechat", "paypal"]);
    expect(methodsForCurrency(list, "EUR")).toEqual([]);
  });

  it("draws the imported QR, else the built link for Venmo, PayPal and Cash App", () => {
    expect(statementPayments(list, "USD", 2550)).toEqual([
      { kind: "zelle", label: "Zelle (Chase)", ...none, email: "alex@example.com", phone: "+1 555 010 0100", link: null, qr: null, qrImported: false, original: null },
      {
        kind: "paypal",
        label: null,
        ...none,
        username: "alexdemo",
        link: "https://paypal.me/alexdemo/25.50USD",
        qr: "https://paypal.me/alexdemo/25.50USD",
        qrImported: false,
        original: null,
      },
      { kind: "zelle", label: null, ...none, link: null, qr: "https://example.com/qr/alex-demo", qrImported: true, original: null },
    ]);
  });

  it("shows the profile's email and phone on the methods that use them, and skips a method left with nothing", () => {
    const methods = [
      method({ kind: "zelle", label: "Zelle (Chase)", useProfileEmail: true, useProfilePhone: true }),
      method({ kind: "paypal", username: "alexdemo", useProfileEmail: true }),
      method({ kind: "zelle", label: "Zelle (work)", email: "alex.work@example.com", useProfilePhone: true }),
    ];
    const profile = { email: "alex@example.com", phone: "+1 555 010 0100" };
    expect(statementPayments(methods, "USD", 2550, profile).map((p) => [p.label, p.email, p.phone])).toEqual([
      ["Zelle (Chase)", "alex@example.com", "+1 555 010 0100"],
      [null, "alex@example.com", null],
      ["Zelle (work)", "alex.work@example.com", "+1 555 010 0100"],
    ]);
    // A new profile phone shows on every method that uses it.
    expect(statementPayments(methods, "USD", 2550, { ...profile, phone: "+1 555 010 0199" }).map((p) => p.phone)).toEqual([
      "+1 555 010 0199",
      null,
      "+1 555 010 0199",
    ]);
    // Without a profile, the first Zelle has nothing left to show.
    expect(statementPayments(methods, "USD", 2550).map((p) => p.label)).toEqual([null, "Zelle (work)"]);
  });

  it("carries the original QR image only when the method shows it", () => {
    const original = { dataUrl: "data:image/webp;base64,AAAA", width: 300, height: 360 };
    const qr = "https://example.com/qr/alex-demo";
    const [shown, kept, lone] = statementPayments(
      [
        method({ kind: "zelle", qr, original, display: "original" }),
        method({ kind: "zelle", qr, original, display: "clean" }),
        method({ kind: "zelle", email: "alex@example.com", original, display: "original" }),
      ],
      "USD",
      2550,
    );
    expect(shown).toMatchObject({ qr, qrImported: true, original });
    expect(kept).toMatchObject({ qr, original: null });
    expect(lone).toMatchObject({ qr: null, original: null });
  });
});

describe("contact info moves to the profile (v0.1.29 upgrade)", () => {
  /** A method as stored before v0.1.29: no profile flags. */
  const old = (m: Partial<StoredPaymentMethod> & Pick<StoredPaymentMethod, "kind">): StoredPaymentMethod => {
    const { useProfileEmail: _e, useProfilePhone: _p, ...rest } = method(m);
    return { ...rest, ...m };
  };
  const empty = { email: null, phone: null };

  it("an empty profile takes the first method's email and phone, and those methods then use it", () => {
    const up = upgradeToProfile(empty, [
      old({ kind: "venmo", username: "@alex-demo" }),
      old({ kind: "zelle", label: "Zelle (Chase)", email: "alex@example.com", phone: "+1 555 010 0100" }),
      old({ kind: "paypal", username: "alexdemo", email: "ALEX@example.com " }),
    ]);
    expect(up.profile).toEqual({ email: "alex@example.com", phone: "+1 555 010 0100" });
    expect(up.methods.map((m) => [m.kind, m.email, m.phone, m.useProfileEmail, m.useProfilePhone])).toEqual([
      ["venmo", null, null, false, false],
      ["zelle", null, null, true, true],
      // Emails compare without case or surrounding spaces.
      ["paypal", null, null, true, false],
    ]);
  });

  it("keeps a profile value that is already set; an equal method value uses it, a different one stays as the override", () => {
    const up = upgradeToProfile({ email: "alex@example.com", phone: null }, [
      old({ kind: "zelle", email: "alex.work@example.com", phone: "+1 555 010 0100" }),
      old({ kind: "venmo", username: "@alex-demo", email: "alex@example.com" }),
    ]);
    expect(up.profile).toEqual({ email: "alex@example.com", phone: "+1 555 010 0100" });
    expect(up.methods.map((m) => [m.email, m.phone, m.useProfileEmail, m.useProfilePhone])).toEqual([
      ["alex.work@example.com", null, false, true],
      [null, null, true, false],
    ]);
  });

  it("compares phones by their digits only", () => {
    expect(sameContact("phone", "+1 (555) 010-0100", "+1 555 010 0100")).toBe(true);
    expect(sameContact("phone", "+1 555 010 0100", "555 010 0100")).toBe(false);
    expect(sameContact("phone", "", "")).toBe(false);
    const up = upgradeToProfile({ email: null, phone: "+1 (555) 010-0100" }, [
      old({ kind: "zelle", phone: "+1 555 010 0100" }),
      old({ kind: "zelle", phone: "+1 555 010 0199" }),
    ]);
    expect(up.profile.phone).toBe("+1 (555) 010-0100");
    expect(up.methods.map((m) => [m.phone, m.useProfilePhone])).toEqual([
      [null, true],
      ["+1 555 010 0199", false],
    ]);
  });

  it("only takes values from fields the kind shows through the profile", () => {
    // A Zelle value that was neither email nor phone stays as text; Alipay's account stays its own.
    const up = upgradeToProfile(empty, [old({ kind: "zelle", text: "alexdemo" }), old({ kind: "alipay", text: "alex@example.com", currencies: ["CNY"] })]);
    expect(up.profile).toEqual(empty);
    expect(up.methods.map((m) => [m.text, m.useProfileEmail, m.useProfilePhone])).toEqual([
      ["alexdemo", false, false],
      ["alex@example.com", false, false],
    ]);
  });

  it("is idempotent: a second run changes nothing, and methods saved since v0.1.29 are left alone", () => {
    const first = upgradeToProfile(empty, [
      old({ kind: "zelle", email: "alex@example.com", phone: "+1 555 010 0100" }),
      old({ kind: "paypal", username: "alexdemo", email: "alex.work@example.com" }),
    ]);
    expect(upgradeToProfile(first.profile, first.methods)).toEqual(first);
    // Cleared later on purpose: a new method's override does not refill the profile.
    const cleared = upgradeToProfile(empty, first.methods);
    expect(cleared.profile).toEqual(empty);
    expect(cleared.methods).toEqual(first.methods);
  });
});
