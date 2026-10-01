import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { defaultDatabaseUrl, findRepoRoot, redactUrl, resolveDbTarget } from "./paths";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("resolveDbTarget", () => {
  const root = findRepoRoot();

  it("defaults to <repo>/data/pglite when DATABASE_URL is unset or blank", () => {
    vi.stubEnv("DATABASE_URL", "  ");
    expect(defaultDatabaseUrl()).toBe(path.join(root, "data", "pglite"));
    expect(resolveDbTarget()).toEqual({ kind: "pglite", dataDir: path.join(root, "data", "pglite") });
    vi.stubEnv("DATABASE_URL", "memory://");
    expect(resolveDbTarget()).toEqual({ kind: "memory" });
  });

  it("resolves relative directories from the repo root and keeps absolute ones", () => {
    expect(resolveDbTarget("data/other")).toEqual({ kind: "pglite", dataDir: path.join(root, "data", "other") });
    expect(resolveDbTarget("/var/yomi/pglite/")).toEqual({ kind: "pglite", dataDir: "/var/yomi/pglite" });
    expect(resolveDbTarget("file:data/x")).toEqual({ kind: "pglite", dataDir: path.join(root, "data", "x") });
    expect(resolveDbTarget("file:/tmp/x")).toEqual({ kind: "pglite", dataDir: "/tmp/x" });
  });

  it("recognizes memory and server URLs", () => {
    expect(resolveDbTarget("memory://")).toEqual({ kind: "memory" });
    expect(resolveDbTarget(":memory:")).toEqual({ kind: "memory" });
    expect(resolveDbTarget("postgres://u:p@h:5432/db")).toEqual({ kind: "server", url: "postgres://u:p@h:5432/db" });
    expect(resolveDbTarget(" postgresql://h/db ")).toEqual({ kind: "server", url: "postgresql://h/db" });
    expect(resolveDbTarget("POSTGRES://h/db").kind).toBe("server");
  });

  it("masks the password in server URLs", () => {
    expect(redactUrl("postgres://u:secret@h:5432/db")).toBe("postgres://u:***@h:5432/db");
    expect(redactUrl("postgres://h/db")).toBe("postgres://h/db");
    expect(redactUrl("not a url")).toBe("postgres://…");
  });
});
