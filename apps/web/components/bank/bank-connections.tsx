"use client";

import { ChartCandlestickIcon, ChartNoAxesColumnIcon, LandmarkIcon, LinkIcon, PauseIcon, PlayIcon, RefreshCwIcon, UnplugIcon } from "lucide-react";
import type { BankConnectionView, BankSyncResult, InvestSyncResult, LinkTokenResult } from "@yomi/contracts";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";
import { toastInvestSync } from "@/components/assets/labels";
import { shortDateTime } from "@/components/import/labels";
import { Button } from "@/components/ui-kit/button";
import { EmptyState } from "@/components/ui-kit/empty-state";
import { ListCard } from "@/components/ui-kit/list-card";
import { DropdownMenuItem, DropdownMenuSeparator } from "@/components/ui/dropdown-menu";
import { fmt } from "@/i18n";
import { useLocale, useT } from "@/i18n/client";
import { noticeText } from "@/i18n/errors";
import { apiFetch } from "@/lib/api";
import { relativeTime } from "@/lib/relative-time";
import { useHydrated } from "@/lib/use-media";
import { cn } from "@/lib/utils";
import { DisconnectDialog } from "./disconnect-dialog";
import { syncSummary } from "./labels";
import { openPlaidLink } from "./plaid-link";
import { MetaPill, menuItem, SourceRow } from "./source-row";

export const INVESTMENTS_HREF = "/assets?view=investments";

/**
 * Plaid connections in one `ListCard` (Assets > Sources lists its brokerages this way).
 * `environments`: environments with a secret configured (a login outside them can only be forgotten
 * locally); null while Plaid is not configured at all, when deleting is refused anyway.
 */
export function BankConnections({ connections, environments }: { connections: BankConnectionView[]; environments: string[] | null }) {
  const t = useT();
  if (connections.length === 0) return <EmptyState icon={LandmarkIcon}>{t.bank.noConnections}</EmptyState>;
  return (
    <ListCard>
      <ul className="divide-y divide-line-soft">
        {connections.map((c) => (
          <ConnectionRow key={c.id} conn={c} environments={environments} />
        ))}
      </ul>
    </ListCard>
  );
}

/**
 * "Synced 2 hours ago" with the absolute time (and how often it syncs) on hover. Both read the viewer's clock and
 * zone, so they render after hydration; until then nothing, so SourceRow drops the part with its separator.
 */
export function SyncedAt({ at, note }: { at: string | null; note?: string }) {
  const t = useT();
  const locale = useLocale();
  const hydrated = useHydrated();
  const c = t.connections;
  if (!at) return <span title={note}>{c.neverSynced}</span>;
  if (!hydrated) return null;
  const title = [fmt(c.lastSynced, { time: shortDateTime(at, locale) }), note].filter(Boolean).join(" · ");
  return <span title={title}>{fmt(c.synced, { time: relativeTime(at, locale, c.justNow) })}</span>;
}

/** One Plaid login (bank or brokerage): sync, pause or resume, reconnect after an error, and the typed disconnect. */
export function ConnectionRow({ conn, environments }: { conn: BankConnectionView; environments: string[] | null }) {
  const router = useRouter();
  const t = useT();
  const locale = useLocale();
  const b = t.bank;
  const c = t.connections;
  const [busy, setBusy] = useState<null | "sync" | "reconnect" | "pause" | "delete">(null);
  const [confirming, setConfirming] = useState(false);
  const off = conn.status === "disconnected";
  const paused = conn.status === "paused";
  const failed = conn.status === "error";
  const brokerage = conn.kind === "brokerage";
  const onAssets = usePathname() === "/assets";
  const name = conn.institutionName ?? b.defaultName;

  async function runSync(prefix: string) {
    if (brokerage) {
      // Holdings, not transactions: pulls every active Plaid brokerage login.
      toastInvestSync(await apiFetch<InvestSyncResult>("/api/invest/sync", { json: { provider: "plaid" } }), t, locale);
      return;
    }
    const r = await apiFetch<BankSyncResult>(`/api/bank/connections/${conn.id}/sync`, { method: "POST" });
    toast.success(fmt(b.resultLine, { prefix, summary: syncSummary(r, t) }));
    if (r.warnings.length) toast.warning(r.warnings.map((w) => noticeText(w, t)).join("\n"));
  }

  async function sync() {
    setBusy("sync");
    try {
      await runSync(b.syncDone);
    } catch {
      // toasted by apiFetch
    } finally {
      setBusy(null);
      router.refresh();
    }
  }

  /** Link update mode: same Item, same access token; afterwards a normal sync clears the error. */
  async function reconnect() {
    setBusy("reconnect");
    try {
      const { linkToken, sessionId } = await apiFetch<LinkTokenResult>("/api/bank/link-token", { json: { connectionId: conn.id } });
      const res = await openPlaidLink(linkToken);
      // Closes the update-mode session record; update mode never adds connections.
      void apiFetch("/api/bank/link-sessions/recover", { json: { sessionId }, silent: true }).catch(() => {});
      if (!res) return;
      await runSync(b.reconnected);
    } catch (e) {
      if (!(e instanceof Error && e.name === "ApiRequestError")) toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
      router.refresh();
    }
  }

  async function setPaused(pause: boolean) {
    setBusy("pause");
    try {
      await apiFetch(`/api/bank/connections/${conn.id}/${pause ? "pause" : "resume"}`, { method: "POST" });
      toast.success(pause ? b.pausedToast : b.resumedToast);
    } catch {
      // toasted by apiFetch
    } finally {
      setBusy(null);
      router.refresh();
    }
  }

  async function disconnect(confirm: string) {
    setBusy("delete");
    try {
      await apiFetch(`/api/bank/connections/${conn.id}`, { method: "DELETE", json: { confirm } });
      setConfirming(false);
      toast.success(b.deletedToast);
      router.refresh();
    } catch {
      // toasted by apiFetch
    } finally {
      setBusy(null);
    }
  }

  // The row's main action: Resume when paused, Reconnect after an error, else Sync now.
  const main = paused
    ? { icon: PlayIcon, label: busy === "pause" ? b.resuming : c.resume, run: () => setPaused(false), soft: false }
    : failed
      ? { icon: LinkIcon, label: busy === "reconnect" ? b.reconnecting : b.reconnect, run: reconnect, soft: true }
      : { icon: RefreshCwIcon, label: busy === "sync" ? b.syncing : b.syncNow, run: sync, soft: false };
  const MainIcon = main.icon;
  const canPause = !paused;
  const assetsLink = brokerage && !onAssets;

  return (
    <>
      <SourceRow
        icon={brokerage ? ChartCandlestickIcon : LandmarkIcon}
        dim={off}
        testId="connection-row"
        name={
          assetsLink ? (
            <Link href={INVESTMENTS_HREF} className="underline-offset-4 hover:underline">
              {name}
            </Link>
          ) : (
            name
          )
        }
        meta={[
          conn.environment && <MetaPill key="env">{b.envs[conn.environment] ?? conn.environment}</MetaPill>,
          <span key="status" className={cn(failed && "font-medium text-foreground")} title={paused ? c.pausedTitle : undefined}>
            {c.status[conn.status] ?? conn.status}
          </span>,
          <SyncedAt key="synced" at={conn.lastSyncedAt} note={brokerage ? c.brokerageInterval : c.bankInterval} />,
        ]}
        extra={
          <>
            {conn.accounts.length > 0 && (
              <ul className="flex flex-col text-meta text-3">
                {conn.accounts.map((a) => (
                  <li key={a.id}>
                    {a.name}
                    {a.lastFour ? <span className="num"> {fmt(c.accountMask, { last4: a.lastFour })}</span> : null}
                    {" · "}
                    {a.type === "credit" ? b.credit : a.type === "depository" ? b.depository : a.type}
                  </li>
                ))}
              </ul>
            )}
            {failed && conn.lastError && <p className="text-meta break-words text-2">{conn.lastError}</p>}
          </>
        }
        actions={
          !off && (
            // The main action sits last, next to the menu, so it lines up with IBKR's Sync now.
            <>
              {canPause && (
                <Button size="sm" variant="ghost" onClick={() => setPaused(true)} disabled={busy != null}>
                  <PauseIcon aria-hidden />
                  {busy === "pause" ? b.pausing : c.pause}
                </Button>
              )}
              <Button size="sm" variant={main.soft ? "soft" : "outline"} onClick={main.run} disabled={busy != null}>
                <MainIcon aria-hidden />
                {main.label}
              </Button>
            </>
          )
        }
        menuLabel={fmt(c.moreActions, { name })}
        menu={
          !off && (
            <>
              <DropdownMenuItem className={cn(menuItem, "md:hidden")} onSelect={main.run} disabled={busy != null}>
                <MainIcon />
                {main.label}
              </DropdownMenuItem>
              {canPause && (
                <DropdownMenuItem className={cn(menuItem, "md:hidden")} onSelect={() => setPaused(true)} disabled={busy != null}>
                  <PauseIcon />
                  {c.pause}
                </DropdownMenuItem>
              )}
              {assetsLink && (
                <DropdownMenuItem className={menuItem} asChild>
                  <Link href={INVESTMENTS_HREF}>
                    <ChartNoAxesColumnIcon />
                    {c.openAssets}
                  </Link>
                </DropdownMenuItem>
              )}
              <DropdownMenuSeparator className={cn(!assetsLink && "md:hidden")} />
              <DropdownMenuItem className={cn(menuItem, "text-neg [&_svg]:text-neg")} onSelect={() => setConfirming(true)} disabled={busy != null}>
                <UnplugIcon />
                {c.disconnect}
              </DropdownMenuItem>
            </>
          )
        }
      />
      {!off && (
        <DisconnectDialog
          open={confirming}
          onOpenChange={setConfirming}
          institutionName={conn.institutionName}
          remote={environments == null || conn.environment == null || environments.includes(conn.environment)}
          brokerage={brokerage}
          busy={busy === "delete"}
          onConfirm={disconnect}
        />
      )}
    </>
  );
}
