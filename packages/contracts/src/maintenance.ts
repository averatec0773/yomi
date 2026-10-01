import { z } from "zod";
import { Locale } from "./common";
import { DateString } from "./ledger";
import { optionalEmail, optionalPhone } from "./payment";

export const BackupResult = z.object({ path: z.string(), fileName: z.string() });
export type BackupResult = z.infer<typeof BackupResult>;

export const TransactionsCsvQuery = z.object({
  month: z
    .string()
    .regex(/^\d{4}-(0[1-9]|1[0-2])$/, "YYYY-MM")
    .optional(),
  from: DateString.optional(),
  to: DateString.optional(),
  locale: Locale.optional(),
}).refine((q) => (q.from === undefined) === (q.to === undefined) && (q.from === undefined || q.from <= q.to!), {
  message: "from and to go together, and from cannot be after to",
});
export type TransactionsCsvQuery = z.infer<typeof TransactionsCsvQuery>;

/** GET/PUT /api/settings/time-zone: the IANA zone days are grouped by. */
export const TimeZoneSetting = z.object({ timeZone: z.string(), isSet: z.boolean() });
export type TimeZoneSetting = z.infer<typeof TimeZoneSetting>;

export const SetTimeZoneInput = z.object({
  timeZone: z.string().trim().min(1).max(64),
  /** Only store it when no zone is set yet (the browser's first-visit detection). */
  ifUnset: z.boolean().optional(),
});
export type SetTimeZoneInput = z.infer<typeof SetTimeZoneInput>;

export const TimeZoneChange = TimeZoneSetting.extend({ changed: z.int().nonnegative() });
export type TimeZoneChange = z.infer<typeof TimeZoneChange>;

/**
 * GET/PUT /api/settings/profile: the name statements use for my share ("Sam's share"), and the email and phone that
 * payment methods show (`useProfileEmail` / `useProfilePhone`); each null when unset. The phone is E.164 (one typed
 * before v0.1.30 that is not a valid number reads as typed).
 */
export const ProfileSetting = z.object({ displayName: z.string().nullable(), email: z.string().nullable(), phone: z.string().nullable() });
export type ProfileSetting = z.infer<typeof ProfileSetting>;

/**
 * Only the fields sent change. Name: trimmed, at most 40 characters. Email: the payment methods' check. Phone: a
 * valid number ("+" international, else read as US), stored as E.164. Empty or null clears a field.
 */
export const SetProfileInput = z.object({
  displayName: z.string().trim().max(40).nullable().optional(),
  email: optionalEmail.optional(),
  phone: optionalPhone.optional(),
});
export type SetProfileInput = z.input<typeof SetProfileInput>;
/** GET/PUT /api/settings/theme: the color theme; `system` follows the OS. */
export const Theme = z.enum(["system", "light", "dark"]);
export type Theme = z.infer<typeof Theme>;

export const ThemeSetting = z.object({ theme: Theme });
export type ThemeSetting = z.infer<typeof ThemeSetting>;

export const SetThemeInput = ThemeSetting;
export type SetThemeInput = z.infer<typeof SetThemeInput>;

/** GET /api/settings/status: read-only setup status (never secrets, only names of missing variables). */
export const SettingsStatus = z.object({
  plaid: z.object({
    configured: z.boolean(),
    environments: z.array(z.string()),
    defaultEnvironment: z.string(),
    missing: z.array(z.string()),
    bankConnections: z.int().nonnegative(),
    brokerageConnections: z.int().nonnegative(),
  }),
  ibkr: z.object({
    configured: z.boolean(),
    missing: z.array(z.string()),
    state: z.enum(["not_configured", "never", "active", "waiting", "error"]),
    lastStatementDate: z.string().nullable(),
    syncedAt: z.string().nullable(),
    positions: z.int().nonnegative(),
    expectedAsOf: z.string(),
    errorCode: z.string().nullable(),
  }),
  security: z.object({
    key: z.enum(["present", "missing", "malformed"]),
    keySource: z.enum(["env", "file", "none"]),
    keyFile: z.string().nullable(),
    encryptedTokens: z.int().nonnegative(),
    plaintextTokens: z.int().nonnegative(),
    unreadableTokens: z.int().nonnegative(),
    errorCode: z.string().nullable(),
  }),
});
export type SettingsStatus = z.infer<typeof SettingsStatus>;

/** POST /api/access: the access token typed on /access. */
export const AccessInput = z.object({ token: z.string().max(1024) });
export type AccessInput = z.infer<typeof AccessInput>;
/** POST / DELETE /api/access; `gate` is false when YOMI_ACCESS_TOKEN is unset (then no cookie is set). */
export const AccessResult = z.object({ ok: z.literal(true), gate: z.boolean() });
export type AccessResult = z.infer<typeof AccessResult>;
