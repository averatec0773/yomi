import path from "node:path";
import { defineConfig, devices } from "@playwright/test";

const root = import.meta.dirname;
/** PGlite data directories, rebuilt by `pnpm demo:db` before each run (one process per directory: the server). */
const db = path.join(root, "data", "demo-e2e-pglite");
const port = 3120;
/** e2e/access.spec.ts runs against a second server with YOMI_ACCESS_TOKEN set (its own DB and build dir). */
export const ACCESS_E2E_PORT = 3420;
export const ACCESS_E2E_TOKEN = "e2e-access-token-3141";
/**
 * The access server also has a made-up IBKR Flex token, so Settings > Connections shows IBKR as set up
 * (e2e/connections.spec.ts). Background sync is off and no test presses its Sync now, so IBKR is never called.
 */
export const ACCESS_E2E_IBKR_TOKEN = "e2e-not-a-flex-token";
/** The access server also has a made-up Plaid client id (and no secret), so Developer keys shows "Set by environment". */
export const ACCESS_E2E_PLAID_CLIENT_ID = "e2e-client-id-3141";
const accessDb = path.join(root, "data", "demo-e2e-access-pglite");
/**
 * The instant every e2e run treats as now: noon in Chicago the day after the demo ledger's last day (2026-09-29,
 * packages/core/src/cli/demo.ts). The servers read it as YOMI_E2E_NOW (only with YOMI_E2E=1, in
 * packages/core/src/time/clock.ts); the browser clock starts at it (e2e/fixtures.ts). Override it with YOMI_E2E_NOW
 * in the shell to check the suite against another day.
 */
export const E2E_NOW = process.env.YOMI_E2E_NOW || "2026-09-30T12:00:00-05:00";
/**
 * Plaid, IBKR and the master key blanked (the root .env.local does not override set variables), background sync off.
 * Each server gets its own key file under data/, removed before the run, so saving a secret creates it fresh and the
 * developer's own key file (~/.config/yomi/secret.key) is never touched. YOMI_E2E=1 routes IBKR Flex calls and
 * Plaid "Test keys" to in-process fakes (apps/web/lib/e2e-fakes.ts) and pins the app's clock to YOMI_E2E_NOW. TZ
 * matches the browser's zone, so server-local "today" does not depend on the machine.
 */
const quietEnv = {
  YOMI_BACKGROUND_SYNC: "0",
  YOMI_E2E: "1",
  YOMI_E2E_NOW: E2E_NOW,
  TZ: "America/Chicago",
  YOMI_SECRET_KEY: "",
  PLAID_CLIENT_ID: "",
  PLAID_SECRET: "",
  PLAID_SECRET_SANDBOX: "",
  PLAID_SECRET_PRODUCTION: "",
  PLAID_ENV: "",
  IBKR_FLEX_TOKEN: "",
  IBKR_FLEX_QUERY_ID: "",
};
export const E2E_KEY_FILE = path.join(root, "data", "demo-e2e-secret.key");
const accessKeyFile = path.join(root, "data", "demo-e2e-access-secret.key");
/**
 * PLAID_SANDBOX_E2E=1 runs only the Plaid Sandbox specs (e2e/plaid-sandbox.spec.ts: bank connect;
 * e2e/plaid-sandbox-invest.spec.ts: brokerage connect; name one file to run just it) against a server you started yourself
 * (PLAID_E2E_BASE_URL, default http://localhost:3160, with PLAID_ENV=sandbox and a throwaway
 * DATABASE_URL passed to the spec as PLAID_E2E_DB; it must be a postgres:// URL, since a PGlite directory is
 * open in the server process only). It needs Plaid Sandbox keys and network, so the default run skips it.
 */
const plaidSandbox = process.env.PLAID_SANDBOX_E2E === "1";

export default defineConfig({
  testDir: "e2e",
  ...(plaidSandbox ? { testMatch: /plaid-sandbox(-invest)?\.spec\.ts$/, timeout: 240_000 } : { testIgnore: /plaid-sandbox(-invest)?\.spec\.ts$/ }),
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [["list"]],
  use: {
    baseURL: plaidSandbox ? (process.env.PLAID_E2E_BASE_URL ?? "http://localhost:3160") : `http://localhost:${port}`,
    trace: "retain-on-failure",
    // The browser reports this zone; on the first visit the app stores it (see apps/web/lib/time-zone.tsx).
    timezoneId: "America/Chicago",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: plaidSandbox ? undefined : [
    {
      // Fresh synthetic ledger every run, then a dev server with its own build dir so it can run beside `pnpm dev`.
      command: `rm -f ${JSON.stringify(E2E_KEY_FILE)} && pnpm demo:db data/demo-e2e-pglite && pnpm --filter @yomi/web exec next dev -p ${port}`,
      cwd: root,
      url: `http://localhost:${port}/transactions`,
      // Access gate off; see quietEnv.
      env: { NEXT_DIST_DIR: ".next-playwright", DATABASE_URL: db, YOMI_ACCESS_TOKEN: "", ...quietEnv, YOMI_SECRET_KEY_FILE: E2E_KEY_FILE },
      reuseExistingServer: false,
      timeout: 180_000,
    },
    {
      command: `rm -f ${JSON.stringify(accessKeyFile)} && pnpm demo:db data/demo-e2e-access-pglite && pnpm --filter @yomi/web exec next dev -p ${ACCESS_E2E_PORT}`,
      cwd: root,
      // /api/health is exempt from the gate, so readiness does not need the token.
      url: `http://localhost:${ACCESS_E2E_PORT}/api/health`,
      env: {
        NEXT_DIST_DIR: ".next-playwright-access",
        DATABASE_URL: accessDb,
        YOMI_ACCESS_TOKEN: ACCESS_E2E_TOKEN,
        ...quietEnv,
        YOMI_SECRET_KEY_FILE: accessKeyFile,
        PLAID_CLIENT_ID: ACCESS_E2E_PLAID_CLIENT_ID,
        IBKR_FLEX_TOKEN: ACCESS_E2E_IBKR_TOKEN,
        IBKR_FLEX_QUERY_ID: "000000",
      },
      reuseExistingServer: false,
      timeout: 180_000,
    },
  ],
});
