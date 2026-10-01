"use client";

import { RefreshCwIcon } from "lucide-react";
import type { AssetsSyncResult } from "@yomi/contracts";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui-kit/button";
import { plural } from "@/i18n";
import { useLocale, useT } from "@/i18n/client";
import { apiFetch } from "@/lib/api";
import { toastInvestSync } from "./labels";

/** "Sync now" on /assets: POST /api/assets/sync (bank balances, holdings, today's snapshots), toasts the outcome, refreshes. */
export function AssetsSyncButton() {
  const router = useRouter();
  const t = useT();
  const locale = useLocale();
  const [busy, setBusy] = useState(false);

  async function sync() {
    setBusy(true);
    try {
      const r = await apiFetch<AssetsSyncResult>("/api/assets/sync", { method: "POST" });
      if (r.bank && r.bank.connections > 0) toast.success(`${t.bank.syncDone}: ${plural(t.assets.syncedParts.bank, r.bank.connections)}`);
      for (const e of r.bank?.errors ?? []) toast.error(e.message, { duration: 10_000 });
      if (r.invest.results.length || r.invest.errors.length || !r.bank?.connections) toastInvestSync(r.invest, t, locale);
    } catch {
      // toasted by apiFetch
    } finally {
      setBusy(false);
      router.refresh();
    }
  }

  return (
    <Button onClick={sync} disabled={busy}>
      <RefreshCwIcon className={busy ? "animate-spin" : undefined} aria-hidden />
      {busy ? t.assets.syncing : t.assets.syncNow}
    </Button>
  );
}
