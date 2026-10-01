export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { getDb } = await import("./lib/db");
    await getDb();
    const { backgroundSyncDecision, getCurrentUser, startBankSyncScheduler, startHoldingsSyncScheduler, resolvePlaidProvider, resolveIbkrSource } =
      await import("@yomi/core");
    const { defaultPgliteDir } = await import("@yomi/db");
    // Background syncs run only on the real ledger (or with YOMI_BACKGROUND_SYNC=1); manual "Sync now" always works.
    const decision = backgroundSyncDecision(process.env, defaultPgliteDir());
    if (!decision.enabled) {
      console.log(`[yomi] Background bank and holdings sync skipped: ${decision.reason}`);
      return;
    }
    // Bank sync job: catches up right away, then every 6 hours. Does nothing until Plaid is configured.
    // Credentials resolve on every tick (env, then Settings), so keys saved in Settings apply without a restart.
    startBankSyncScheduler({ getDb, getUser: getCurrentUser, getProvider: async () => resolvePlaidProvider(await getDb()) });
    // Holdings sync: IBKR once per trading day after the close, Plaid brokerages daily. Idle until configured.
    startHoldingsSyncScheduler({
      getDb,
      getUser: getCurrentUser,
      getIbkr: async () => resolveIbkrSource(await getDb(), getCurrentUser()),
      getPlaid: async () => resolvePlaidProvider(await getDb()),
    });
  }
}
