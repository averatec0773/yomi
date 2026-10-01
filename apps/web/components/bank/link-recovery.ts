import type { LinkRecoverBody, LinkRecoveryResult } from "@yomi/contracts";
import type { Dictionary } from "../../i18n/en";
import { fmt } from "../../i18n/format";

/** Stands in for an institution Plaid did not name; the message shows the dictionary's default bank name. */
const BANK = "";

/**
 * Waits between recovery attempts after Link closed: Plaid may need a moment before
 * /link/token/get shows the session as finished. Longer when the bank login was done.
 */
export const RECOVER_DELAYS_MS = { connected: [0, 2000, 5000, 10000], other: [0, 3000] } as const;

export interface ExitRecovery {
  /** Names of the institutions whose connection was recovered ("" when Plaid gave none). */
  recovered: string[];
  /** The bank login was done but no Item could be saved: tell the user to contact Plaid support. */
  lost: boolean;
  /** Plaid's link_session_id, for support. */
  linkSessionId: string | null;
  error: string | null;
}

/**
 * Asks the server to recover the Link session `sessionId` after Link closed without onSuccess,
 * retrying while Plaid still reports the session as open. Never throws.
 */
export async function recoverAfterExit(
  input: { sessionId: number; linkSessionId: string | null; connected: boolean },
  post: (body: LinkRecoverBody) => Promise<LinkRecoveryResult>,
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
): Promise<ExitRecovery> {
  const out: ExitRecovery = { recovered: [], lost: false, linkSessionId: input.linkSessionId, error: null };
  let saved = false;
  for (const delay of input.connected ? RECOVER_DELAYS_MS.connected : RECOVER_DELAYS_MS.other) {
    if (delay) await sleep(delay);
    let r: LinkRecoveryResult;
    try {
      r = await post({ sessionId: input.sessionId, linkSessionId: input.linkSessionId });
    } catch (e) {
      out.error = e instanceof Error ? e.message : String(e);
      continue;
    }
    out.recovered.push(...r.recovered.map((x) => x.institutionName ?? BANK));
    const s = r.sessions.find((x) => x.id === input.sessionId);
    if (s?.linkSessionId) out.linkSessionId = s.linkSessionId;
    if (s && (s.status === "recovered" || s.status === "completed" || s.alreadyConnected > 0)) saved = true;
    out.error = s?.error ?? null;
    if (!s || s.status !== "open") break;
  }
  out.lost = input.connected && out.recovered.length === 0 && !saved;
  return out;
}

export function recoveredMessage(names: string[], t: Dictionary): string {
  return fmt(t.bank.recovered, { names: names.map((n) => (n === BANK ? t.bank.defaultName : n)).join(t.common.listSep) });
}

export function lostMessage(linkSessionId: string | null, t: Dictionary): string {
  return fmt(t.bank.lost, { id: linkSessionId ?? t.bank.unknownId });
}
