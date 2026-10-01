import type { BankEnvironment, EnrollmentResult } from "@yomi/contracts";

/**
 * A public token from Link onSuccess that has not been exchanged yet. Kept in sessionStorage so a
 * page reload between onSuccess and /api/bank/exchange does not lose the login (public tokens live
 * 30 minutes at Plaid; an Item burned on the Trial plan does not come back).
 */
export interface PendingExchange {
  publicToken: string;
  institution: { name: string; institution_id?: string } | null;
  environment: BankEnvironment;
  /** ISO time of onSuccess. */
  at: string;
  /** Server-side Link session (LinkTokenResult.sessionId), so recovery knows this token was exchanged. */
  sessionId?: number;
}

export const PENDING_KEY = "yomi.plaid.pending";
/** Public tokens expire after 30 minutes; leave a margin. */
export const PENDING_MAX_AGE_MS = 25 * 60 * 1000;
export const EXCHANGE_RETRY_DELAYS_MS = [1000, 3000] as const;

export function serializePending(p: PendingExchange): string {
  return JSON.stringify(p);
}

/** Null for anything that is not a well-formed pending exchange. */
export function parsePending(raw: string | null): PendingExchange | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as Partial<PendingExchange>;
    if (typeof v.publicToken !== "string" || !v.publicToken) return null;
    if (v.environment !== "sandbox" && v.environment !== "production") return null;
    if (typeof v.at !== "string" || Number.isNaN(Date.parse(v.at))) return null;
    const inst = v.institution;
    const institution = inst && typeof inst.name === "string" ? inst : null;
    const sessionId = typeof v.sessionId === "number" && v.sessionId > 0 ? v.sessionId : undefined;
    return { publicToken: v.publicToken, institution, environment: v.environment, at: v.at, ...(sessionId ? { sessionId } : {}) };
  } catch {
    return null;
  }
}

/** Whether the public token can still be exchanged at `now`. */
export function isPendingFresh(p: PendingExchange, now: Date = new Date()): boolean {
  const age = now.getTime() - Date.parse(p.at);
  return age >= 0 && age < PENDING_MAX_AGE_MS;
}

export function savePending(p: PendingExchange): void {
  try {
    sessionStorage.setItem(PENDING_KEY, serializePending(p));
  } catch {
    // storage blocked: the exchange below still runs, only reload protection is lost
  }
}

export function loadPending(): PendingExchange | null {
  try {
    return parsePending(sessionStorage.getItem(PENDING_KEY));
  } catch {
    return null;
  }
}

export function clearPending(): void {
  try {
    sessionStorage.removeItem(PENDING_KEY);
  } catch {
    // nothing to clear
  }
}

/** Client errors (4xx) will not change on retry; network failures and 5xx might. */
function retryable(e: unknown): boolean {
  const status = (e as { status?: unknown })?.status;
  return typeof status !== "number" || status === 0 || status >= 500;
}

/**
 * POSTs the pending exchange, retrying after 1 s and 3 s on network or server errors. The pending
 * entry is cleared only after a 2xx; a 4xx also clears it (the token was rejected, retrying is useless).
 */
export async function finishExchange(
  p: PendingExchange,
  post: (body: {
    public_token: string;
    institution: PendingExchange["institution"];
    environment: BankEnvironment;
    sessionId?: number;
  }) => Promise<EnrollmentResult>,
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
): Promise<EnrollmentResult> {
  const body = { public_token: p.publicToken, institution: p.institution, environment: p.environment, ...(p.sessionId ? { sessionId: p.sessionId } : {}) };
  for (let attempt = 0; ; attempt++) {
    try {
      const out = await post(body);
      clearPending();
      return out;
    } catch (e) {
      const delay = EXCHANGE_RETRY_DELAYS_MS[attempt];
      if (delay == null || !retryable(e)) {
        if (!retryable(e)) clearPending();
        throw e;
      }
      await sleep(delay);
    }
  }
}
