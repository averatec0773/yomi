import { parsePhoneNumberFromString } from "libphonenumber-js/min";
import { z } from "zod";
import { CurrencyCode } from "./common";

/** How someone can pay the user (Settings > Profile > Payment methods); shown on statements under "My payment details". */
export const PAYMENT_KINDS = ["zelle", "venmo", "paypal", "cashapp", "alipay", "wechat", "other"] as const;
export const PaymentKind = z.enum(PAYMENT_KINDS);
export type PaymentKind = z.infer<typeof PaymentKind>;

export const PAYMENT_METHODS_MAX = 6;
export const PAYMENT_LABEL_MAX = 40;
export const PAYMENT_HANDLE_MAX = 200;
/** A QR code holds at most about 3 KB; a payment QR is a short link. */
export const PAYMENT_QR_MAX = 2048;
/** The original QR card image: at most 600 px wide and 300 KB (WebP, else PNG). */
export const PAYMENT_ORIGINAL_MAX_WIDTH = 600;
export const PAYMENT_ORIGINAL_MAX_HEIGHT = 2400;
export const PAYMENT_ORIGINAL_MAX_BYTES = 300 * 1024;
export const PAYMENT_DISPLAYS = ["clean", "original"] as const;
export const PaymentDisplay = z.enum(PAYMENT_DISPLAYS);
export type PaymentDisplay = z.infer<typeof PaymentDisplay>;

const DATA_URL_PATTERN = /^data:image\/(webp|png);base64,([A-Za-z0-9+/]+={0,2})$/;

/** The decoded size in bytes of a base64 data URL (its payload after the comma). */
export function dataUrlBytes(dataUrl: string): number {
  const b64 = dataUrl.slice(dataUrl.indexOf(",") + 1);
  const padding = b64.endsWith("==") ? 2 : b64.endsWith("=") ? 1 : 0;
  return Math.floor((b64.length * 3) / 4) - padding;
}

/**
 * A crop of the user's own QR screenshot (their bank's Zelle card, name and logo included), shown on statements when
 * `display` is "original". Stored inline as a WebP or PNG data URL; the decoded QR payload is always kept beside it.
 */
export const PaymentOriginal = z.object({
  dataUrl: z
    .string()
    .max(Math.ceil((PAYMENT_ORIGINAL_MAX_BYTES * 4) / 3) + 32)
    .regex(DATA_URL_PATTERN, { message: "Not a WebP or PNG image" })
    .refine((v) => dataUrlBytes(v) <= PAYMENT_ORIGINAL_MAX_BYTES, { message: "The image is larger than 300 KB" }),
  width: z.number().int().min(16).max(PAYMENT_ORIGINAL_MAX_WIDTH),
  height: z.number().int().min(16).max(PAYMENT_ORIGINAL_MAX_HEIGHT),
});
export type PaymentOriginal = z.infer<typeof PaymentOriginal>;

/** Currencies a new method of this kind is offered for: CNY for Alipay and WeChat, USD for the rest. */
export function defaultPaymentCurrencies(kind: PaymentKind): string[] {
  return kind === "alipay" || kind === "wechat" ? ["CNY"] : ["USD"];
}

const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .nullish()
    .transform((v) => (v ? v : null));

/** Same patterns as @yomi/core/payment (`looksLikeEmail`, `looksLikePhone`), which upgrades values stored before them. */
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PHONE_PATTERN = /^\+?[\d\s()-]+$/;

/** A trimmed email or null (empty clears it); also Settings > Profile's email. */
export const optionalEmail = optionalText(PAYMENT_HANDLE_MAX).refine((v) => v === null || EMAIL_PATTERN.test(v), { message: "Not an email address" });
/** The number as E.164 when it is a valid phone number ("+" international, else read as a US number), else null. */
function e164(v: string): string | null {
  const p = parsePhoneNumberFromString(v, "US");
  return p && p.isValid() ? p.number : null;
}

/** A valid phone number stored as E.164 ("+12025550143"), or null (empty clears it); Settings > Profile's phone. */
export const optionalPhone = optionalText(40)
  .refine((v) => v === null || e164(v) !== null, { message: "Not a valid phone number" })
  .transform((v) => (v === null ? null : e164(v)));

/**
 * A payment method's own phone: a valid number as E.164, or a value saved before v0.1.30 that is not one but passes
 * the old check (digits, spaces, "+", "-", parentheses, 7 to 20 digits), kept as typed so a list holding it still
 * saves; the method dialog asks for a valid number before it saves a new one.
 */
export const methodPhone = optionalText(40)
  .refine(
    (v) => {
      if (v === null || e164(v) !== null) return true;
      const digits = v.replace(/\D/g, "").length;
      return PHONE_PATTERN.test(v) && digits >= 7 && digits <= 20;
    },
    { message: "Not a phone number" },
  )
  .transform((v) => (v === null ? null : (e164(v) ?? v)));

/**
 * One method as sent by the client. Its own contact fields per kind: Venmo, PayPal and Cash App `username`; Alipay and
 * WeChat `text` (the account); Other `text` (text or a link). Email and phone come from Settings > Profile:
 * `useProfileEmail` / `useProfilePhone` show the profile's value (Zelle both, Venmo / PayPal / Cash App the email,
 * Alipay / WeChat / Other both); `email` / `phone` set here are this method's override and win over the profile.
 * Each is trimmed and null when empty; at least one of them, a profile flag or a QR payload is required (the form
 * asks for the kind's own field, this stays lenient so values upgraded from the old single `handle` still save).
 * `qr` is the decoded QR text. `original` is an optional crop of the imported screenshot, kept only with a `qr`;
 * `display` picks what statements show ("clean": the QR drawn from `qr`, the default; "original": the crop).
 * `currencies` defaults by kind.
 */
export const PaymentMethodInput = z
  .object({
    kind: PaymentKind,
    label: optionalText(PAYMENT_LABEL_MAX),
    email: optionalEmail,
    phone: methodPhone,
    username: optionalText(PAYMENT_HANDLE_MAX),
    text: optionalText(PAYMENT_HANDLE_MAX),
    useProfileEmail: z.boolean().default(false),
    useProfilePhone: z.boolean().default(false),
    qr: optionalText(PAYMENT_QR_MAX),
    original: PaymentOriginal.nullish().transform((v) => v ?? null),
    display: PaymentDisplay.default("clean"),
    currencies: z.array(CurrencyCode).min(1).max(8).optional(),
    showOnStatement: z.boolean().default(true),
  })
  .transform((m) => ({
    kind: m.kind,
    label: m.label,
    email: m.email,
    phone: m.phone,
    username: m.username,
    text: m.text,
    useProfileEmail: m.useProfileEmail,
    useProfilePhone: m.useProfilePhone,
    qr: m.qr,
    original: m.original,
    display: m.display,
    currencies: m.currencies ? [...new Set(m.currencies)] : defaultPaymentCurrencies(m.kind),
    showOnStatement: m.showOnStatement,
  }))
  .refine((m) => Boolean(m.email || m.phone || m.username || m.text || m.useProfileEmail || m.useProfilePhone || m.qr), {
    path: ["email"],
    message: "An email, phone, username, text, a profile value or a QR code is required",
  })
  .refine((m) => !m.original || m.qr, { path: ["original"], message: "An original image needs its QR payload" })
  .refine((m) => m.display === "clean" || m.original, { path: ["display"], message: "Original needs an image" });
export type PaymentMethodInput = z.input<typeof PaymentMethodInput>;
export type PaymentMethod = z.output<typeof PaymentMethodInput>;

/** GET/PUT /api/settings/payment-methods: the whole list, in display order. */
export const PaymentMethodsSetting = z.object({ methods: z.array(PaymentMethodInput).max(PAYMENT_METHODS_MAX) });
export type PaymentMethodsSetting = z.output<typeof PaymentMethodsSetting>;

export const SetPaymentMethodsInput = PaymentMethodsSetting;
export type SetPaymentMethodsInput = z.input<typeof SetPaymentMethodsInput>;

/** A method as a statement shows it: the link built for this statement (amount included where documented). */
export const StatementPayment = z.object({
  kind: PaymentKind,
  label: z.string().nullable(),
  /** Resolved: the method's own email, else the profile's when the method uses it. */
  email: z.string().nullable(),
  /** Resolved like `email`, as stored (E.164); the UI and the text show it through @yomi/core/phone `formatPhone`. */
  phone: z.string().nullable(),
  username: z.string().nullable(),
  text: z.string().nullable(),
  /** A link to open: built from the username (Venmo, PayPal, Cash App) or the text itself when it is a URL. */
  link: z.string().nullable(),
  /** The QR payload to draw: the imported QR, else the built link; null for none. */
  qr: z.string().nullable(),
  /** True when `qr` came from an imported QR code. */
  qrImported: z.boolean(),
  /** The user's own QR card image, shown instead of the drawn QR when the method's display is "original". */
  original: PaymentOriginal.nullable(),
});
export type StatementPayment = z.infer<typeof StatementPayment>;
