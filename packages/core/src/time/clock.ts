// The app's "now" for calendar questions (today, this month, days until a token expires). Pure, safe to import from
// the web client.

type Env = Record<string, string | undefined>;

/** The process env on the server; in the browser bundle `process.env` has neither variable, so the real clock wins. */
function processEnv(): Env {
  return typeof process === "undefined" ? {} : (process.env ?? {});
}

/**
 * The current instant. Only when YOMI_E2E=1 (Playwright's servers, see playwright.config.ts) does YOMI_E2E_NOW, an
 * ISO instant with an offset, pin it, so e2e runs see the same day as the fixed demo ledger whatever the real date.
 * Instants stored as audit stamps (created/updated/synced at) keep the real clock; this answers "what day is it".
 */
export function clockNow(env: Env = processEnv()): Date {
  const pinned = env.YOMI_E2E === "1" ? env.YOMI_E2E_NOW : undefined;
  if (!pinned) return new Date();
  const ms = Date.parse(pinned);
  if (Number.isNaN(ms)) throw new Error(`YOMI_E2E_NOW is not an ISO instant: ${pinned}`);
  return new Date(ms);
}
