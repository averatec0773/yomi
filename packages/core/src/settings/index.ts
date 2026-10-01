import { bankConnections, type Db } from "@yomi/db";
import { and, eq, ne } from "@yomi/db/orm";
import { type IbkrStatus, ibkrStatus } from "../invest/status";
import { secretKeyInfo } from "../secrets/keyfile";
import { secretsHealth } from "../secrets/tokens";
import { resolvePlaidConfig } from "../sync/credentials";
import { clockNow } from "../time/clock";
import type { CurrentUser } from "../user";

export * from "./payment";
export * from "./profile";
export * from "./shortcuts";
export * from "./theme";
export * from "./time-zone";

/** Read-only setup status for the settings page (env, then Settings). Names of missing env variables only, never values. */
export interface SettingsStatus {
  plaid: {
    configured: boolean;
    environments: string[];
    defaultEnvironment: string;
    missing: string[];
    /** Connections not disconnected, by kind. */
    bankConnections: number;
    brokerageConnections: number;
  };
  /** Setup, latest statement and sync state; never the token or the query id. */
  ibkr: IbkrStatus;
  security: {
    /** The master key (YOMI_SECRET_KEY, else the key file): set, not set, or not a valid key. */
    key: "present" | "missing" | "malformed";
    /** Where the key comes from. */
    keySource: "env" | "file" | "none";
    /** The key file path when yomi uses (or would create) one; null when YOMI_SECRET_KEY is set. */
    keyFile: string | null;
    encryptedTokens: number;
    plaintextTokens: number;
    /** Stored tokens the current key cannot decrypt. */
    unreadableTokens: number;
    errorCode: string | null;
  };
}

export async function settingsStatus(db: Db, user: CurrentUser, env: NodeJS.ProcessEnv = process.env, now: Date = clockNow()): Promise<SettingsStatus> {
  const plaid = await resolvePlaidConfig(db, env);
  const secrets = await secretsHealth(db, env);
  const count = async (kind: "bank" | "brokerage") =>
    (await db
      .select({ id: bankConnections.id })
      .from(bankConnections)
      .where(and(eq(bankConnections.userId, user.id), eq(bankConnections.kind, kind), ne(bankConnections.status, "disconnected")))
      ).length;
  return {
    plaid: {
      configured: plaid.configured,
      environments: plaid.environments,
      defaultEnvironment: plaid.defaultEnvironment,
      missing: plaid.missing,
      bankConnections: await count("bank"),
      brokerageConnections: await count("brokerage"),
    },
    ibkr: await ibkrStatus(db, user, env, now),
    security: {
      key: secrets.key,
      keySource: secrets.keySource,
      keyFile: secretKeyInfo(env).file,
      encryptedTokens: secrets.encrypted,
      plaintextTokens: secrets.plaintext,
      unreadableTokens: secrets.undecryptable,
      errorCode: secrets.errorCode,
    },
  };
}
export * from "./secrets";
