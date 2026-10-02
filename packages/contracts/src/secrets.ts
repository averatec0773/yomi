import { z } from "zod";
import { DateString } from "./ledger";

/**
 * Credentials entered in Settings (IBKR Flex per user, Plaid developer keys per instance). Secrets are write-only:
 * the API never returns their value, only whether it is set, its last 4 characters and where it comes from.
 * Identifiers (the Flex query ID, the Plaid client ID) are not secret and also carry their saved `value`.
 */
export const SecretSource = z.enum(["env", "settings"]);
export type SecretSource = z.infer<typeof SecretSource>;

export const SecretField = z.object({
  configured: z.boolean(),
  last4: z.string().max(4).nullable(),
  source: SecretSource.nullable(),
  /** Saved in Settings but the current key cannot open it. */
  unreadable: z.boolean(),
});
export type SecretField = z.infer<typeof SecretField>;

/** An identifier stored like a secret but shown in clear: `value` is the one saved in Settings, null when unset, unreadable or from env. */
export const IdentifierField = SecretField.extend({ value: z.string().nullable() });
export type IdentifierField = z.infer<typeof IdentifierField>;

export const PlaidEnvironmentName = z.enum(["sandbox", "production"]);

export const TokenExpiry = z.object({
  state: z.enum(["none", "ok", "soon", "expired"]),
  days: z.int().nullable(),
});
export type TokenExpiry = z.infer<typeof TokenExpiry>;

export const IbkrSecretsView = z.object({
  token: SecretField,
  queryId: IdentifierField,
  expiresOn: DateString.nullable(),
  expiry: TokenExpiry,
});
export type IbkrSecretsView = z.infer<typeof IbkrSecretsView>;

export const PlaidSecretsView = z.object({
  clientId: IdentifierField,
  sandbox: SecretField,
  production: SecretField,
  defaultEnvironment: z.object({ value: PlaidEnvironmentName.nullable(), source: SecretSource.nullable() }),
});
export type PlaidSecretsView = z.infer<typeof PlaidSecretsView>;

/** GET /api/settings/secrets. */
export const SecretsView = z.object({
  ibkr: IbkrSecretsView,
  plaid: PlaidSecretsView,
  key: z.object({
    source: z.enum(["env", "file", "none"]),
    state: z.enum(["present", "missing", "malformed"]),
    /** The key file path (created on the first save when no key exists yet); null when YOMI_SECRET_KEY is set. */
    file: z.string().nullable(),
  }),
});
export type SecretsView = z.infer<typeof SecretsView>;

const secretValue = z.string().trim().min(1).max(512);

/** POST /api/settings/secrets/ibkr/test: fields left out use the current (env or saved) value. */
export const IbkrTestInput = z.object({ token: secretValue.optional(), queryId: secretValue.optional() });
export type IbkrTestInput = z.infer<typeof IbkrTestInput>;
/**
 * One Flex section yomi reads and what the pulls say about it (an empty section counts as present). `unknown`:
 * Trades or Cash Transactions absent only on windows shorter than 30 days, which IBKR leaves out without activity.
 */
export const IbkrSectionItem = z.object({
  id: z.enum(["accountInformation", "openPositions", "cashReport", "trades", "cashTransactions", "nav"]),
  state: z.enum(["present", "missing", "unknown"]),
});
export type IbkrSectionItem = z.infer<typeof IbkrSectionItem>;

export const IbkrTestResult = z.object({
  ok: z.literal(true),
  statementDate: DateString,
  positions: z.int().nonnegative(),
  accounts: z.int().nonnegative(),
  /** The six sections in reading order; a test on the saved query also counts its earlier pulls. */
  sections: z.array(IbkrSectionItem),
});
export type IbkrTestResult = z.infer<typeof IbkrTestResult>;

/** PUT /api/settings/secrets/ibkr: the fields sent are saved; expiresOn null clears the date. */
export const IbkrSaveInput = z.object({
  token: secretValue.optional(),
  queryId: z.string().trim().regex(/^\d{1,20}$/, "digits").optional(),
  expiresOn: DateString.nullable().optional(),
});
export type IbkrSaveInput = z.infer<typeof IbkrSaveInput>;

/** POST /api/settings/secrets/plaid/test: client id and secret left out use the current (env or saved) value. */
export const PlaidTestInput = z.object({ environment: PlaidEnvironmentName, clientId: secretValue.optional(), secret: secretValue.optional() });
export type PlaidTestInput = z.infer<typeof PlaidTestInput>;
export const PlaidTestResult = z.union([
  z.object({ ok: z.literal(true) }),
  z.object({ ok: z.literal(false), code: z.string(), message: z.string() }),
]);
export type PlaidTestResult = z.infer<typeof PlaidTestResult>;

/** PUT /api/settings/secrets/plaid. */
export const PlaidSaveInput = z.object({
  clientId: secretValue.optional(),
  sandbox: secretValue.optional(),
  production: secretValue.optional(),
  defaultEnvironment: PlaidEnvironmentName.nullable().optional(),
});
export type PlaidSaveInput = z.infer<typeof PlaidSaveInput>;

export const PlaidKeyField = z.enum(["clientId", "sandbox", "production"]);
export type PlaidKeyField = z.infer<typeof PlaidKeyField>;
