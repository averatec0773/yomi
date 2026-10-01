/**
 * Payment methods on statements ("My payment details"): pure helpers shared by core (the statement text) and the web
 * app (Settings preview), importable on the client as `@yomi/core/payment`. Validation lives in @yomi/contracts
 * (PaymentMethodInput); storage in settings/payment.ts.
 */

import { formatMinorDecimal } from "./money";
import { formatPhone } from "./phone";

export const PAYMENT_KINDS = ["zelle", "venmo", "paypal", "cashapp", "alipay", "wechat", "other"] as const;
export type PaymentKind = (typeof PAYMENT_KINDS)[number];
export const PAYMENT_METHODS_MAX = 6;

/**
 * How someone reaches the user's account, per method. Venmo, PayPal, Cash App: the username. Alipay, WeChat: the
 * account (text). Other: text or a link. `email` and `phone` are this method's own values (an override); usually a
 * method shows the profile's email and phone instead (`useProfileEmail`, `useProfilePhone`, see `profileFields`).
 * Null when empty.
 */
export interface PaymentContact {
  email: string | null;
  phone: string | null;
  username: string | null;
  text: string | null;
}
export const PAYMENT_CONTACT_FIELDS = ["email", "phone", "username", "text"] as const;
export type PaymentContactField = (typeof PAYMENT_CONTACT_FIELDS)[number];

/** The email and phone on Settings > Profile, shared by every method that shows them. Null when empty. */
export interface ProfileContact {
  email: string | null;
  phone: string | null;
}
export const PROFILE_CONTACT_FIELDS = ["email", "phone"] as const;
export type ProfileContactField = (typeof PROFILE_CONTACT_FIELDS)[number];
export const NO_PROFILE_CONTACT: ProfileContact = { email: null, phone: null };

/** Whether a method shows the profile's email / phone (ignored while it has its own value). */
export interface ProfileFlags {
  useProfileEmail: boolean;
  useProfilePhone: boolean;
}
export const PROFILE_FLAG = { email: "useProfileEmail", phone: "useProfilePhone" } as const satisfies Record<ProfileContactField, keyof ProfileFlags>;

/** A crop of the user's own QR screenshot (WebP or PNG data URL, at most 600 px wide), in its own pixels. */
export interface PaymentOriginal {
  dataUrl: string;
  width: number;
  height: number;
}
/** What statements show for an imported QR: the code drawn from its payload, or the user's own crop. */
export type PaymentDisplay = "clean" | "original";

export interface PaymentMethod extends PaymentContact, ProfileFlags {
  kind: PaymentKind;
  label: string | null;
  /** Decoded QR payload (text); always kept, also when the original image is shown. */
  qr: string | null;
  /** The crop of the imported screenshot, only beside a `qr`; kept while `display` is "clean". */
  original: PaymentOriginal | null;
  display: PaymentDisplay;
  currencies: string[];
  showOnStatement: boolean;
}

/** A method as one statement shows it. */
export interface StatementPayment extends PaymentContact {
  kind: PaymentKind;
  label: string | null;
  link: string | null;
  qr: string | null;
  qrImported: boolean;
  /** Set when the statement shows the user's own QR image instead of drawing `qr`. */
  original: PaymentOriginal | null;
}

export function isPaymentKind(value: unknown): value is PaymentKind {
  return typeof value === "string" && (PAYMENT_KINDS as readonly string[]).includes(value);
}

/** CNY for Alipay and WeChat, USD for the rest. */
export function defaultPaymentCurrencies(kind: PaymentKind): string[] {
  return kind === "alipay" || kind === "wechat" ? ["CNY"] : ["USD"];
}

/** The method's own contact fields the form shows for a kind (besides the profile's email and phone). */
export function paymentFields(kind: PaymentKind): readonly PaymentContactField[] {
  switch (kind) {
    case "zelle":
      return [];
    case "venmo":
    case "paypal":
    case "cashapp":
      return ["username"];
    default:
      return ["text"];
  }
}

/**
 * The profile values a method of this kind can show, in the form's order: Zelle email and phone; Venmo, PayPal and
 * Cash App the email; Alipay and WeChat phone and email; Other email and phone.
 */
export function profileFields(kind: PaymentKind): readonly ProfileContactField[] {
  switch (kind) {
    case "zelle":
    case "other":
      return ["email", "phone"];
    case "alipay":
    case "wechat":
      return ["phone", "email"];
    default:
      return ["email"];
  }
}

/** The flags a new method of this kind starts with: Zelle shows both profile values, the rest start without them. */
export function defaultProfileFlags(kind: PaymentKind): ProfileFlags {
  return { useProfileEmail: kind === "zelle", useProfilePhone: kind === "zelle" };
}

/**
 * The email and phone a method shows: its own value (an override) when it has one, else the profile's when the method
 * uses it and its kind shows that field. Username and text are the method's own.
 */
export function resolveContact(m: Pick<PaymentMethod, "kind"> & PaymentContact & Partial<ProfileFlags>, profile: ProfileContact): PaymentContact {
  const pick = (f: ProfileContactField): string | null => {
    if (m[f]) return m[f];
    return m[PROFILE_FLAG[f]] && profileFields(m.kind).includes(f) ? profile[f] : null;
  };
  return { email: pick("email"), phone: pick("phone"), username: m.username, text: m.text };
}

/**
 * True when the method has what its kind needs (resolved values: see `resolveContact`), or a QR code: Zelle an email
 * or a phone; Venmo / PayPal / Cash App a username; Alipay / WeChat / Other the account text, an email or a phone.
 */
export function hasRequiredContact(m: Pick<PaymentMethod, "kind" | "qr"> & Partial<PaymentContact>): boolean {
  if (m.qr) return true;
  switch (m.kind) {
    case "zelle":
      return Boolean(m.email || m.phone);
    case "venmo":
    case "paypal":
    case "cashapp":
      return Boolean(m.username);
    default:
      return Boolean(m.text || m.email || m.phone);
  }
}

/** The email check @yomi/contracts' PaymentMethodInput uses: something@domain.tld without spaces. */
export const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
/** Digits, spaces, "+", "-" and parentheses; @yomi/contracts uses the same pattern. */
export const PHONE_PATTERN = /^\+?[\d\s()-]+$/;

export function looksLikeEmail(text: string): boolean {
  return EMAIL_PATTERN.test(text.trim());
}

/** A phone number as the contract accepts it: digits, spaces, "+", "-", "()", with 7 to 20 digits. */
export function looksLikePhone(text: string): boolean {
  const t = text.trim();
  if (!PHONE_PATTERN.test(t)) return false;
  const digits = t.replace(/\D/g, "").length;
  return digits >= 7 && digits <= 20;
}

/**
 * A value stored before v0.1.26 as one `handle`, moved to a field its kind shows: Alipay, WeChat and Other keep it as
 * the account text; Zelle takes an email or a phone; Venmo, PayPal and Cash App take an email as the email and
 * anything else as the username. A Zelle value that is neither stays as text, so nothing is lost.
 */
export function upgradeHandle(kind: PaymentKind, handle: string): PaymentContact {
  const none: PaymentContact = { email: null, phone: null, username: null, text: null };
  const h = handle.trim();
  if (!h) return none;
  if (paymentFields(kind).includes("text")) return { ...none, text: h };
  if (looksLikeEmail(h)) return { ...none, email: h };
  if (kind === "zelle") return looksLikePhone(h) ? { ...none, phone: h } : { ...none, text: h };
  return { ...none, username: h };
}

/** Hosts a pasted profile link may carry, per kind; the username is what follows them. */
const HOSTS: Partial<Record<PaymentKind, RegExp>> = {
  venmo: /^(?:https?:\/\/)?(?:www\.|account\.)?venmo\.com\/(?:u\/)?/i,
  paypal: /^(?:https?:\/\/)?(?:www\.)?paypal\.me\//i,
  cashapp: /^(?:https?:\/\/)?(?:www\.)?cash\.app\//i,
};

/** The bare username of a Venmo, PayPal.me or Cash App username ("@alex-demo", "paypal.me/alex", "$alex"), or null. */
export function paymentSlug(kind: PaymentKind, username: string): string | null {
  const host = HOSTS[kind];
  if (!host) return null;
  const slug = username
    .trim()
    .replace(host, "")
    .replace(/[/?#].*$/, "")
    .replace(/^[@$]/, "");
  return /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/.test(slug) ? slug : null;
}

export function isHttpUrl(text: string): boolean {
  return /^https?:\/\/[^\s/$.?#].[^\s]*$/i.test(text.trim());
}

/**
 * The link a statement offers for a method: Venmo `https://venmo.com/u/<username>` (no amount: the web link does not
 * document one), PayPal.me `https://paypal.me/<username>/<amount><CUR>` and Cash App `https://cash.app/$<tag>/<amount>`
 * (USD only) with the amount when one is given, or the account text itself when it is a web link. Zelle, Alipay and
 * WeChat get no built link: their QR formats are not public.
 */
export function paymentLink(
  method: Pick<PaymentMethod, "kind"> & Partial<Pick<PaymentContact, "username" | "text">>,
  amount?: { minor: number; currency: string },
): string | null {
  const slug = paymentSlug(method.kind, method.username ?? "");
  const pay = amount && amount.minor > 0 ? amount : null;
  switch (method.kind) {
    case "venmo":
      return slug ? `https://venmo.com/u/${slug}` : null;
    case "paypal":
      return slug ? `https://paypal.me/${slug}${pay ? `/${formatMinorDecimal(pay.minor, pay.currency)}${pay.currency}` : ""}` : null;
    case "cashapp":
      return slug ? `https://cash.app/$${slug}${pay && pay.currency === "USD" ? `/${formatMinorDecimal(pay.minor, "USD")}` : ""}` : null;
    default:
      return method.text && isHttpUrl(method.text) ? method.text.trim() : null;
  }
}

/** Methods shown on a statement in `currency`: switched on and offered for that currency, in the user's order. */
export function methodsForCurrency<M extends Pick<PaymentMethod, "showOnStatement" | "currencies">>(methods: readonly M[], currency: string): M[] {
  return methods.filter((m) => m.showOnStatement && m.currencies.includes(currency));
}

/**
 * The statement's payment details for `currency`; the amount (what they pay, when positive) goes into the links that
 * document one. Email and phone are resolved against the profile (`resolveContact`), so a profile change shows on
 * every method that uses it. The QR is the imported one, else the built link for Venmo, PayPal and Cash App;
 * `original` carries the user's own QR image when the method shows it. A method left with nothing to show (it only
 * used a profile value that is now empty) is skipped.
 */
export function statementPayments(
  methods: readonly PaymentMethod[],
  currency: string,
  amountMinor: number,
  profile: ProfileContact = NO_PROFILE_CONTACT,
): StatementPayment[] {
  return methodsForCurrency(methods, currency)
    .map((m): StatementPayment => {
      const link = paymentLink(m, { minor: amountMinor, currency });
      const built = m.kind === "venmo" || m.kind === "paypal" || m.kind === "cashapp" ? link : null;
      return {
        kind: m.kind,
        label: m.label,
        ...resolveContact(m, profile),
        link,
        qr: m.qr ?? built,
        qrImported: m.qr !== null,
        original: m.qr !== null && m.display === "original" ? m.original : null,
      };
    })
    .filter((p) => Boolean(p.email || p.phone || p.username || p.text || p.link || p.qr));
}

/** Same value for the profile upgrade: emails ignoring case and spaces around them, phones by their digits only. */
export function sameContact(field: ProfileContactField, a: string, b: string): boolean {
  if (field === "email") return a.trim().toLowerCase() === b.trim().toLowerCase();
  const digits = (v: string) => v.replace(/\D/g, "");
  return digits(a) !== "" && digits(a) === digits(b);
}

/** A method as stored: one saved before v0.1.29 has neither profile flag (`isLegacyContact`). */
export type StoredPaymentMethod = Omit<PaymentMethod, keyof ProfileFlags> & Partial<ProfileFlags>;

export function isLegacyContact(m: StoredPaymentMethod): boolean {
  return m.useProfileEmail === undefined && m.useProfilePhone === undefined;
}

/**
 * The v0.1.29 upgrade (contact info moves to the profile), for each of email and phone: an empty profile value takes
 * the first old method's value (list order); an old method whose value equals the profile's (`sameContact`) then
 * uses the profile and keeps no own value; a different value stays as that method's override. Methods saved since
 * v0.1.29 are left as they are, so running it again changes nothing.
 */
export function upgradeToProfile(profile: ProfileContact, methods: readonly StoredPaymentMethod[]): { profile: ProfileContact; methods: PaymentMethod[] } {
  const next: ProfileContact = { ...profile };
  for (const f of PROFILE_CONTACT_FIELDS) {
    if (!next[f]) next[f] = methods.find((m) => isLegacyContact(m) && m[f] && profileFields(m.kind).includes(f))?.[f] ?? null;
  }
  return {
    profile: next,
    methods: methods.map((m): PaymentMethod => {
      if (!isLegacyContact(m)) return { ...m, useProfileEmail: m.useProfileEmail ?? false, useProfilePhone: m.useProfilePhone ?? false };
      const out: PaymentMethod = { ...m, useProfileEmail: false, useProfilePhone: false };
      for (const f of PROFILE_CONTACT_FIELDS) {
        const own = m[f];
        const shared = next[f];
        if (own && shared && profileFields(m.kind).includes(f) && sameContact(f, own, shared)) {
          out[f] = null;
          out[PROFILE_FLAG[f]] = true;
        }
      }
      return out;
    }),
  };
}

/**
 * The contact values of a method as one line of plain text, in field order (email, phone, username, text), the phone
 * formatted for a statement in `currency` (`formatPhone`), then the link when it is not one of them already.
 */
export function contactParts(m: PaymentContact & { link: string | null }, currency?: string): string[] {
  const parts = [m.email, m.phone ? formatPhone(m.phone, { currency }) : null, m.username, m.text].filter((v): v is string => Boolean(v));
  if (m.link && !parts.includes(m.link)) parts.push(m.link);
  return parts;
}

/**
 * "Zelle (Chase)" when the label names the service, else "Zelle · Joint account"; the kind alone without a label, and
 * the label alone for "other" ("Bank transfer").
 */
export function paymentTitle(kind: PaymentKind, kindName: string, label: string | null): string {
  if (!label) return kindName;
  if (kind === "other") return label;
  return label.toLowerCase().includes(kindName.toLowerCase()) ? label : `${kindName} · ${label}`;
}

/** A link shown as text: without the scheme and a trailing slash ("venmo.com/u/alex-demo"). */
export function linkText(link: string): string {
  return link.replace(/^https?:\/\//i, "").replace(/\/$/, "");
}
