import { z } from "zod";
import { Notice } from "./common";

export const BankEnvironment = z.enum(["sandbox", "production"]);
export type BankEnvironment = z.infer<typeof BankEnvironment>;

/** GET /api/bank/config. Never carries the client id, a secret or any access token. */
export const BankConfig = z.object({
  provider: z.literal("plaid"),
  configured: z.boolean(),
  /** Environment the connect-bank flow ("Connect bank") uses. */
  defaultEnvironment: BankEnvironment,
  /** Environments with a secret configured. */
  environments: z.array(BankEnvironment),
  missing: z.array(z.string()),
});
export type BankConfig = z.infer<typeof BankConfig>;

/**
 * POST /api/bank/link-token. With connectionId: Link update mode for that connection (re-login, in
 * the connection's environment). Otherwise a new login in `environment` (default: defaultEnvironment).
 */
export const LinkTokenBody = z.object({
  connectionId: z.int().positive().optional(),
  environment: BankEnvironment.optional(),
  /**
   * New logins only. bank (default): Plaid product transactions. brokerage: Plaid product investments;
   * the login becomes a brokerage connection that syncs holdings and never transactions.
   */
  purpose: z.enum(["bank", "brokerage"]).optional(),
});
export type LinkTokenBody = z.infer<typeof LinkTokenBody>;

/**
 * POST /api/bank/link-exit: what Plaid Link reported when it closed with an error or was abandoned,
 * or an ERROR event on the way. Diagnostics only (logged server side); never carries a token.
 */
const diag = z.string().max(500).nullish();
export const LinkExitBody = z.object({
  kind: z.enum(["exit", "event"]),
  errorCode: diag,
  errorType: diag,
  errorMessage: diag,
  displayMessage: diag,
  institution: diag,
  status: diag,
  linkSessionId: diag,
  requestId: diag,
});
export type LinkExitBody = z.infer<typeof LinkExitBody>;

/** `sessionId`: the server-side record of this link token (plaid_link_sessions), for exchange and recovery. */
export const LinkTokenResult = z.object({ linkToken: z.string(), expiration: z.string(), sessionId: z.int() });
export type LinkTokenResult = z.infer<typeof LinkTokenResult>;

/** POST /api/bank/exchange: what Plaid Link passes to onSuccess (public_token + metadata.institution). */
export const ExchangeBody = z.object({
  public_token: z.string().min(1),
  /** Environment the link token was made for; defaults to the one in the public token. */
  environment: BankEnvironment.optional(),
  institution: z.object({ name: z.string(), institution_id: z.string().optional() }).nullable().optional(),
  /** LinkTokenResult.sessionId of the Link session that produced the token. */
  sessionId: z.int().positive().optional(),
});
export type ExchangeBody = z.infer<typeof ExchangeBody>;

export const BankAccountView = z.object({
  id: z.int(),
  accountId: z.int(),
  name: z.string(),
  type: z.string(),
  subtype: z.string().nullable(),
  lastFour: z.string().nullable(),
  currency: z.string(),
});
export type BankAccountView = z.infer<typeof BankAccountView>;

export const BankConnectionView = z.object({
  id: z.int(),
  provider: z.literal("plaid"),
  /** bank: transactions sync; brokerage: holdings only (see /api/invest). */
  kind: z.enum(["bank", "brokerage"]),
  /** sandbox | production, read from the stored token; null once disconnected. */
  environment: z.string().nullable(),
  institutionName: z.string().nullable(),
  /** paused: kept but skipped by the scheduler and manual sync until resumed; nothing is sent to Plaid. */
  status: z.enum(["active", "paused", "disconnected", "error"]),
  lastError: z.string().nullable(),
  lastSyncedAt: z.string().nullable(),
  createdAt: z.string(),
  accounts: z.array(BankAccountView),
});
export type BankConnectionView = z.infer<typeof BankConnectionView>;

/**
 * DELETE /api/bank/connections/:id removes the login at Plaid (/item/remove; on Trial the slot is not
 * returned), so the caller must repeat the institution name exactly (see disconnectConfirmText).
 */
export const DisconnectBody = z.object({ confirm: z.string().max(200) });
export type DisconnectBody = z.infer<typeof DisconnectBody>;

/** What must be typed to delete a connection: its institution name, or "bank" when Plaid gave none. */
export function disconnectConfirmText(institutionName: string | null): string {
  return institutionName?.trim() || "bank";
}

/** Case-sensitive match after trimming what was typed. Shared by the dialog and the API guard. */
export function disconnectConfirmMatches(institutionName: string | null, typed: string | null | undefined): boolean {
  return typeof typed === "string" && typed.trim() === disconnectConfirmText(institutionName);
}

export const BankConnectionList = z.object({ connections: z.array(BankConnectionView) });
export type BankConnectionList = z.infer<typeof BankConnectionList>;

export const BankSyncResult = z.object({
  connectionId: z.int(),
  batchId: z.int().nullable(),
  fetched: z.int(),
  inserted: z.int(),
  skippedDup: z.int(),
  linked: z.int(),
  autoSplit: z.int(),
  modified: z.int(),
  removed: z.int(),
  warnings: z.array(Notice),
});
export type BankSyncResult = z.infer<typeof BankSyncResult>;

/** POST /api/bank/exchange answers with the new connection and the result of its first sync. */
export const EnrollmentResult = z.object({
  connection: BankConnectionView,
  sync: BankSyncResult.nullable(),
  syncError: z.string().nullable(),
});
export type EnrollmentResult = z.infer<typeof EnrollmentResult>;

/**
 * POST /api/bank/link-sessions/recover: asks Plaid which Items open Link sessions created and saves
 * the ones the browser never delivered. Without a body: every open session. With sessionId: that
 * one (plus Plaid's link_session_id from onExit, kept for support).
 */
export const LinkRecoverBody = z.object({
  sessionId: z.int().positive().optional(),
  linkSessionId: z.string().max(200).nullish(),
});
export type LinkRecoverBody = z.infer<typeof LinkRecoverBody>;

export const RecoveredItemView = z.object({
  sessionId: z.int(),
  connectionId: z.int(),
  institutionName: z.string().nullable(),
  sync: BankSyncResult.nullable(),
  syncError: z.string().nullable(),
});
export type RecoveredItemView = z.infer<typeof RecoveredItemView>;

export const LinkSessionOutcomeView = z.object({
  id: z.int(),
  purpose: z.enum(["new", "update"]),
  status: z.enum(["open", "completed", "recovered", "abandoned", "expired"]),
  linkSessionId: z.string().nullable(),
  exitStatus: z.string().nullable(),
  recovered: z.array(RecoveredItemView),
  alreadyConnected: z.int(),
  error: z.string().nullable(),
});
export type LinkSessionOutcomeView = z.infer<typeof LinkSessionOutcomeView>;

export const LinkRecoveryResult = z.object({
  sessions: z.array(LinkSessionOutcomeView),
  recovered: z.array(RecoveredItemView),
});
export type LinkRecoveryResult = z.infer<typeof LinkRecoveryResult>;
