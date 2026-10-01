import { describe, expect, it } from "vitest";
import {
  finishExchange,
  isPendingFresh,
  parsePending,
  type PendingExchange,
  PENDING_MAX_AGE_MS,
  serializePending,
} from "./pending-exchange";

const p: PendingExchange = {
  publicToken: "public-production-abc",
  institution: { name: "Bank of America", institution_id: "ins_127989" },
  environment: "production",
  at: "2026-09-29T10:00:00.000Z",
};

describe("pending exchange", () => {
  it("round-trips and rejects malformed entries", () => {
    expect(parsePending(serializePending(p))).toEqual(p);
    expect(parsePending(serializePending({ ...p, institution: null }))).toEqual({ ...p, institution: null });
    expect(parsePending(null)).toBeNull();
    expect(parsePending("{not json")).toBeNull();
    expect(parsePending(JSON.stringify({ ...p, publicToken: "" }))).toBeNull();
    expect(parsePending(JSON.stringify({ ...p, environment: "development" }))).toBeNull();
    expect(parsePending(JSON.stringify({ ...p, at: "yesterday" }))).toBeNull();
  });

  it("is fresh for 25 minutes", () => {
    const t = Date.parse(p.at);
    expect(isPendingFresh(p, new Date(t + 60_000))).toBe(true);
    expect(isPendingFresh(p, new Date(t + PENDING_MAX_AGE_MS - 1))).toBe(true);
    expect(isPendingFresh(p, new Date(t + PENDING_MAX_AGE_MS))).toBe(false);
    expect(isPendingFresh(p, new Date(t - 60_000))).toBe(false);
  });

  it("retries network and server errors after 1 s and 3 s, not client errors", async () => {
    const waits: number[] = [];
    const sleep = async (ms: number) => void waits.push(ms);
    let calls = 0;
    const ok = { connection: {}, sync: null, syncError: null } as never;
    const flaky = async () => {
      calls++;
      if (calls < 3) throw Object.assign(new Error("down"), { status: 502 });
      return ok;
    };
    expect(await finishExchange(p, flaky, sleep)).toBe(ok);
    expect([calls, waits]).toEqual([3, [1000, 3000]]);

    calls = 0;
    waits.length = 0;
    await expect(finishExchange(p, async () => (calls++, Promise.reject(new Error("offline"))), sleep)).rejects.toThrow("offline");
    expect([calls, waits]).toEqual([3, [1000, 3000]]);

    calls = 0;
    await expect(
      finishExchange(p, async () => (calls++, Promise.reject(Object.assign(new Error("bad"), { status: 400 }))), sleep),
    ).rejects.toThrow("bad");
    expect(calls).toBe(1);
    const body: unknown[] = [];
    await finishExchange(p, async (b) => (body.push(b), ok), sleep);
    expect(body).toEqual([{ public_token: p.publicToken, institution: p.institution, environment: "production" }]);
  });
});
