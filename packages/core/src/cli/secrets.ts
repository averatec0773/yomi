// `pnpm secrets:gen-key` prints a new YOMI_SECRET_KEY.
// `pnpm secrets:scrub-backups [--apply] [file|dir]...` counts (and with --apply encrypts in place) the
// plaintext Plaid tokens in the PGlite backups (data/backups/*.tar.gz) and any path given. Never deletes a file.
import path from "node:path";
import { generateSecretKey, SecretKeyError } from "../secrets/crypto";
import { activeSecretKey } from "../secrets/keyfile";
import { backupFiles, defaultBackupsDir, scrubBackupFile } from "../secrets/scrub";
import { loadRootEnv } from "./env";

const [cmd, ...rest] = process.argv.slice(2);

if (cmd === "gen-key") {
  console.log(generateSecretKey());
  console.log(
    "Put it in .env.local at the project root (YOMI_SECRET_KEY=<the line above>) and in your password manager. Losing this key means reconnecting your banks (on a Plaid plan that caps Items, that uses up more of them).",
  );
} else if (cmd === "scrub-backups") {
  loadRootEnv();
  const apply = rest.includes("--apply");
  const targets = rest.filter((a) => !a.startsWith("--"));
  let key: Buffer | null = null;
  try {
    key = activeSecretKey();
  } catch (e) {
    console.error(e instanceof SecretKeyError ? e.message : String(e));
    process.exit(1);
  }
  if (apply && !key) {
    console.error("--apply needs YOMI_SECRET_KEY (in .env.local, or set for this command) or the secret key file");
    process.exit(1);
  }
  const files = backupFiles([defaultBackupsDir(), ...targets]);
  if (files.length === 0) console.log("No backup files found");
  let left = 0;
  let failed = 0;
  for (const f of files) {
    const r = await scrubBackupFile(f, { key: apply ? key : null });
    const name = path.relative(process.cwd(), f) || f;
    left += r.plaintext - r.rewritten;
    if (r.error) {
      failed += 1;
      console.log(`${name}: failed, unchanged (${r.error})`);
    } else if (!apply) {
      console.log(`${name}: ${r.plaintext} plaintext credential(s), ${r.encrypted} encrypted`);
    } else {
      console.log(`${name}: ${r.rewritten ? `encrypted ${r.rewritten} plaintext credential(s)` : "no plaintext credentials, unchanged"}`);
    }
  }
  if (!apply && left > 0) console.log(`${left} plaintext credential(s) in total. Run pnpm secrets:scrub-backups --apply to encrypt them in place (no file is deleted).`);
  if (failed) process.exit(1);
} else {
  console.error("usage: pnpm secrets:gen-key | pnpm secrets:scrub-backups [--apply] [backup.tar.gz|dir]...");
  process.exit(1);
}
