"use client";

import { ChartCandlestickIcon, LandmarkIcon } from "lucide-react";
import type { BankEnvironment, EnrollmentResult, LinkRecoverBody, LinkRecoveryResult, LinkTokenResult } from "@yomi/contracts";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui-kit/button";
import { fmt } from "@/i18n";
import { getClientDictionary, useT } from "@/i18n/client";
import { apiFetch } from "@/lib/api";
import { syncSummary } from "./labels";
import { lostMessage, recoverAfterExit, recoveredMessage } from "./link-recovery";
import { clearPending, finishExchange, isPendingFresh, loadPending, type PendingExchange } from "./pending-exchange";
import { type LinkExitInfo, openPlaidLink } from "./plaid-link";

const postRecover = (json: LinkRecoverBody) => apiFetch<LinkRecoveryResult>("/api/bank/link-sessions/recover", { json, silent: true });

/**
 * Link closed without onSuccess (any status): ask the server to fetch Items Plaid created in the
 * session anyway. Toasts a recovered connection, or, when the bank login was done and nothing could
 * be saved, a lasting message with the link_session_id for Plaid support. Resolves true if something was recovered.
 */
export async function recoverExitedSession(sessionId: number, info: LinkExitInfo): Promise<boolean> {
  const r = await recoverAfterExit({ sessionId, linkSessionId: info.linkSessionId, connected: info.connected }, postRecover);
  const t = getClientDictionary();
  if (r.recovered.length) {
    toast.success(recoveredMessage(r.recovered, t));
    return true;
  }
  if (r.lost) toast.error(lostMessage(r.linkSessionId, t), { duration: Infinity, closeButton: true });
  return false;
}

/** Exchanges a saved public token (with retries) and toasts the outcome. Resolves false on failure. */
async function completeExchange(p: PendingExchange): Promise<boolean> {
  const t = getClientDictionary();
  const c = t.bank.connect;
  try {
    const out = await finishExchange(p, (json) => apiFetch<EnrollmentResult>("/api/bank/exchange", { json, silent: true }));
    const name = out.connection.institutionName ?? t.bank.defaultName;
    if (out.sync) toast.success(fmt(c.connectedSync, { name, summary: syncSummary(out.sync, t) }));
    else if (out.syncError) toast.warning(fmt(c.connectedSyncFailed, { name, error: out.syncError }));
    else toast.success(fmt(c.connected, { name }));
    return true;
  } catch (e) {
    toast.error(fmt(c.saveFailed, { error: e instanceof Error ? e.message : String(e) }));
    return false;
  }
}

/**
 * On mount: finishes an exchange a reload interrupted (public token saved in onSuccess, younger
 * than 25 minutes), then asks the server to recover any Link session that created an Item the
 * browser never delivered (Link closed early, page reloaded mid-session).
 */
export function ResumePendingExchange() {
  const router = useRouter();
  const t = useT();
  const started = useRef(false);
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    void (async () => {
      let changed = false;
      const p = loadPending();
      if (p && !isPendingFresh(p)) {
        clearPending();
        toast.warning(fmt(t.bank.connect.expired, { name: p.institution?.name ?? t.bank.defaultName }));
      } else if (p) {
        toast.info(t.bank.connect.resuming);
        changed = await completeExchange(p);
      }
      try {
        const r = await postRecover({});
        if (r.recovered.length) {
          toast.success(recoveredMessage(r.recovered.map((x) => x.institutionName ?? t.bank.defaultName), t));
          changed = true;
        }
      } catch {
        // the job retries every 10 minutes
      }
      if (changed) router.refresh();
    })();
  }, [router, t]);
  return null;
}

/**
 * The connect flow: fresh link token for `environment` → Plaid Link → exchange the public token (first
 * sync runs server side). `purpose="brokerage"` runs the same flow for a brokerage login (Plaid
 * Investments; holdings only). `confirmSandbox` asks before a Sandbox login writes test data into the ledger.
 */
export function useConnectFlow({
  environment,
  purpose = "bank",
  confirmSandbox = false,
}: {
  environment: BankEnvironment;
  purpose?: "bank" | "brokerage";
  confirmSandbox?: boolean;
}) {
  const router = useRouter();
  const t = useT();
  const c = t.bank.connect;
  const [busy, setBusy] = useState<null | "loading" | "saving">(null);

  async function open() {
    if (confirmSandbox && environment === "sandbox" && !window.confirm(c.sandboxConfirm)) return;
    setBusy("loading");
    try {
      const { linkToken, sessionId } = await apiFetch<LinkTokenResult>("/api/bank/link-token", {
        json: purpose === "brokerage" ? { environment, purpose } : { environment },
      });
      let exit: LinkExitInfo | null = null;
      let res: Awaited<ReturnType<typeof openPlaidLink>> = null;
      try {
        res = await openPlaidLink(linkToken, { pendingEnvironment: environment, sessionId, onExit: (i) => (exit = i) });
      } finally {
        if (exit) {
          // Every exit, error or not: Plaid may have created the Item before the user left.
          setBusy("saving");
          if (await recoverExitedSession(sessionId, exit)) router.refresh();
        }
      }
      if (!res) return;
      setBusy("saving");
      const p: PendingExchange = {
        publicToken: res.publicToken,
        institution: res.metadata.institution,
        environment,
        at: new Date().toISOString(),
        sessionId,
      };
      const ok = await completeExchange(p);
      // Double check: anything else the session created (and closes the session record).
      const extra = await postRecover({ sessionId }).catch(() => null);
      if (extra?.recovered.length) toast.success(recoveredMessage(extra.recovered.map((x) => x.institutionName ?? t.bank.defaultName), t));
      if (ok || extra?.recovered.length) router.refresh();
    } catch (e) {
      // apiFetch toasts its own errors; Link and script errors are toasted here.
      if (!(e instanceof Error && e.name === "ApiRequestError")) toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }

  /** The label while busy ("Opening…", "Saving and syncing…"), else null. */
  const busyText = busy === "saving" ? c.saving : busy === "loading" ? c.opening : null;
  return { open, busy: busy != null, busyText };
}

/** "Connect bank" / "Connect brokerage" as a button (40px `md`, outline unless `variant`). */
export function ConnectBankButton({
  environment,
  label,
  purpose = "bank",
  variant = "outline",
  className,
}: {
  environment: BankEnvironment;
  label?: string;
  purpose?: "bank" | "brokerage";
  variant?: "primary" | "outline";
  className?: string;
}) {
  const t = useT();
  const c = t.bank.connect;
  const flow = useConnectFlow({ environment, purpose });
  return (
    <Button variant={variant} phoneSoft onClick={flow.open} disabled={flow.busy} className={className}>
      {purpose === "brokerage" ? <ChartCandlestickIcon aria-hidden /> : <LandmarkIcon aria-hidden />}
      {flow.busyText ?? label ?? (purpose === "brokerage" ? c.brokerageButton : c.button)}
    </Button>
  );
}
