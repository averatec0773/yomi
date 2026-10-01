import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { closeDb, createDb, migrate, pgliteOf } from "./packages/db/src/client";
import { TEMPLATE_ENV } from "./packages/db/src/testing";

// Migrates one in-memory PGlite per run and writes its data directory to a temp file; @yomi/db/testing loads
// every test file's database from it (see packages/db/src/testing.ts). Workers inherit the variable.
export default async function setup(): Promise<() => void> {
  const dir = mkdtempSync(path.join(tmpdir(), "yomi-test-template-"));
  const file = path.join(dir, "migrated.tar");
  const db = await createDb("memory://");
  await migrate(db);
  const dump = await pgliteOf(db)!.dumpDataDir("none");
  writeFileSync(file, new Uint8Array(await dump.arrayBuffer()));
  await closeDb(db);
  process.env[TEMPLATE_ENV] = file;
  return () => rmSync(dir, { recursive: true, force: true });
}
