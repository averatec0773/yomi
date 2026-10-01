import path from "node:path";
import { findRepoRoot } from "@yomi/db";
import { describe, expect, it } from "vitest";
import { backgroundSyncDecision } from "./background";

const def = path.join(findRepoRoot(), "data", "pglite");

describe("backgroundSyncDecision", () => {
  it("runs on the default ledger", () => {
    expect(backgroundSyncDecision({}, def).enabled).toBe(true);
    expect(backgroundSyncDecision({ DATABASE_URL: "" }, def).enabled).toBe(true);
    expect(backgroundSyncDecision({ DATABASE_URL: def }, def).enabled).toBe(true);
    expect(backgroundSyncDecision({ DATABASE_URL: `${def}/` }, def).enabled).toBe(true);
    expect(backgroundSyncDecision({ DATABASE_URL: `file:${def}` }, def).enabled).toBe(true);
    // Relative paths resolve from the repo root (as createDb does), whatever the working directory.
    expect(backgroundSyncDecision({ DATABASE_URL: "data/pglite" }, def).enabled).toBe(true);
  });

  it("skips any other ledger unless forced on", () => {
    const off = backgroundSyncDecision({ DATABASE_URL: path.join(findRepoRoot(), "data", "demo-pglite") }, def);
    expect(off.enabled).toBe(false);
    expect(off.reason).toContain("DATABASE_URL");
    expect(backgroundSyncDecision({ DATABASE_URL: "memory://" }, def).enabled).toBe(false);
    expect(backgroundSyncDecision({ DATABASE_URL: "postgres://yomi@localhost:5432/yomi" }, def).enabled).toBe(false);
    expect(backgroundSyncDecision({ DATABASE_URL: "postgres://yomi@localhost:5432/yomi", YOMI_BACKGROUND_SYNC: "1" }, def).enabled).toBe(true);
    expect(backgroundSyncDecision({ DATABASE_URL: "data/demo-pglite", YOMI_BACKGROUND_SYNC: "1" }, def).enabled).toBe(true);
  });

  it("YOMI_BACKGROUND_SYNC=0 always disables", () => {
    expect(backgroundSyncDecision({ YOMI_BACKGROUND_SYNC: "0" }, def).enabled).toBe(false);
    expect(backgroundSyncDecision({ DATABASE_URL: def, YOMI_BACKGROUND_SYNC: "0" }, def).enabled).toBe(false);
  });
});
