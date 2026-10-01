import type { LinkRecoveryResult, LinkSessionOutcomeView } from "@yomi/contracts";
import { describe, expect, it } from "vitest";
import { recoverAfterExit, RECOVER_DELAYS_MS } from "./link-recovery";

const session = (o: Partial<LinkSessionOutcomeView>): LinkSessionOutcomeView => ({
  id: 7,
  purpose: "new",
  status: "open",
  linkSessionId: "sess-plaid",
  exitStatus: null,
  recovered: [],
  alreadyConnected: 0,
  error: null,
  ...o,
});
const answer = (s: LinkSessionOutcomeView | null): LinkRecoveryResult => ({ sessions: s ? [s] : [], recovered: s?.recovered ?? [] });
const item = { sessionId: 7, connectionId: 3, institutionName: "Bank of America", sync: null, syncError: null };

describe("recoverAfterExit", () => {
  it("retries while Plaid still shows the session open, then reports the recovered bank", async () => {
    const waits: number[] = [];
    const replies = [answer(session({})), answer(session({ status: "recovered", recovered: [item] }))];
    const r = await recoverAfterExit({ sessionId: 7, linkSessionId: "from-exit", connected: true }, async () => replies.shift()!, async (ms) => void waits.push(ms));
    expect(r).toEqual({ recovered: ["Bank of America"], lost: false, linkSessionId: "sess-plaid", error: null });
    expect(waits).toEqual([2000]);
  });

  it("connected but nothing recoverable after every retry: lost, with the link_session_id", async () => {
    let calls = 0;
    const r = await recoverAfterExit({ sessionId: 7, linkSessionId: "from-exit", connected: true }, async () => (calls++, answer(session({ linkSessionId: null }))), async () => {});
    expect(calls).toBe(RECOVER_DELAYS_MS.connected.length);
    expect(r).toMatchObject({ lost: true, linkSessionId: "from-exit", recovered: [] });
  });

  it("not lost when the session was already saved elsewhere, or when the login was never done", async () => {
    const done = await recoverAfterExit({ sessionId: 7, linkSessionId: null, connected: true }, async () => answer(session({ status: "recovered" })), async () => {});
    expect(done.lost).toBe(false);
    const quit = await recoverAfterExit({ sessionId: 7, linkSessionId: null, connected: false }, async () => answer(session({ status: "abandoned" })), async () => {});
    expect(quit).toMatchObject({ lost: false, recovered: [] });
    let calls = 0;
    await recoverAfterExit({ sessionId: 7, linkSessionId: null, connected: false }, async () => (calls++, Promise.reject(new Error("down"))), async () => {});
    expect(calls).toBe(RECOVER_DELAYS_MS.other.length);
  });
});
