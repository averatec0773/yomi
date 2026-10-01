import { z } from "zod";

export const CurrencyCode = z.string().regex(/^[A-Z]{3}$/, "ISO 4217 code, e.g. CNY");
export type CurrencyCode = z.infer<typeof CurrencyCode>;

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
