import { FlexError, type InvestStatement } from "@yomi/importers";
import { InvestError, type InvestErrorCode } from "./errors";

export const IBKR_TOKEN_ENV = "IBKR_FLEX_TOKEN";
export const IBKR_QUERY_ENV = "IBKR_FLEX_QUERY_ID";

/** What the UI may know about the IBKR setup: never the token or the query id. */
export interface IbkrConfig {
  configured: boolean;
  /** Names of what is missing (the env variable names, also used for the Settings fields). */
  missing: string[];
}

/** From env only. Everything that runs uses resolveIbkrConfig (env, then Settings) from ./credentials. */
export function ibkrConfig(env: NodeJS.ProcessEnv = process.env): IbkrConfig {
  const missing = [IBKR_TOKEN_ENV, IBKR_QUERY_ENV].filter((k) => !env[k]?.trim());
  return { configured: missing.length === 0, missing };
}

/** Pulls the configured Activity Flex Query and maps it. Injected in tests. */
export interface IbkrSource {
  fetchStatement(): Promise<InvestStatement>;
}

/** FlexError → InvestError (same code and params); any other failure while reading the statement → invest_ibkr_statement_invalid. */
export function toInvestError(e: unknown): InvestError {
  if (e instanceof InvestError) return e;
  if (e instanceof FlexError) return new InvestError(e.code as InvestErrorCode, e.message, e.params);
  const detail = e instanceof Error ? e.message : String(e);
  return new InvestError("invest_ibkr_statement_invalid", `The Flex statement could not be read: ${detail}`, { detail });
}
