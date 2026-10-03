import { z } from "zod";

export const CurrencyCode = z.string().regex(/^[A-Z]{3}$/, "ISO 4217 code, e.g. CNY");
export type CurrencyCode = z.infer<typeof CurrencyCode>;

export const MonthString = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, "YYYY-MM");
export type MonthString = z.infer<typeof MonthString>;

/** A real calendar date 'YYYY-MM-DD'. */
export const DateString = z
  .string()
  .regex(/^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/, "YYYY-MM-DD")
  .refine((s) => {
    const [y, m, d] = s.split("-").map(Number) as [number, number, number];
    return d <= new Date(Date.UTC(y, m, 0)).getUTCDate();
  }, "no such date");
export type DateString = z.infer<typeof DateString>;

/** A positive integer id in a query string ("12"). */
export const QueryId = z.coerce.number().int().positive();

/** A yes/no flag in a query string or form field: true, 1, yes, on (and their opposites), any case. */
export const QueryFlag = z.stringbool();

/** Integer minor units (fen / cents) plus currency. Never a float. */
export const Money = z.object({
  amountMinor: z.int(),
  currency: CurrencyCode,
});
export type Money = z.infer<typeof Money>;

/** Language of text the server writes for the user to share (statement text, CSV headers). */
export const Locale = z.enum(["en", "zh-CN"]);
export type Locale = z.infer<typeof Locale>;

/** Interpolation values of a coded message or notice. */
export const MessageParams = z.record(z.string(), z.union([z.string(), z.number()]));
export type MessageParams = z.infer<typeof MessageParams>;

/** A warning with a stable code (translated by the UI), its params and an English message. */
export const Notice = z.object({ code: z.string(), params: MessageParams, message: z.string() });
export type Notice = z.infer<typeof Notice>;

export const SourceId = z.enum(["alipay", "wechat", "icbc_pdf", "plaid", "boa_csv", "sms"]);
export type SourceId = z.infer<typeof SourceId>;
