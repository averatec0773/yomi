"use client";

import { ChartCandlestickIcon, ChartNoAxesColumnIcon, KeyRoundIcon, RefreshCwIcon, SettingsIcon } from "lucide-react";
import type { InvestSyncResult, SecretsView, SettingsStatus } from "@yomi/contracts";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { toastInvestSync } from "@/components/assets/labels";
import { Button } from "@/components/ui-kit/button";
import { DropdownMenuItem, DropdownMenuSeparator } from "@/components/ui/dropdown-menu";
import { fmt, plural } from "@/i18n";
import { useLocale, useT } from "@/i18n/client";
import { errorText } from "@/i18n/errors";
import { apiFetch } from "@/lib/api";
import { dayLabel } from "@/lib/month";
import { cn } from "@/lib/utils";
import { INVESTMENTS_HREF, SyncedAt } from "./bank-connections";
import { IbkrSetupDialog } from "./ibkr-setup-dialog";
import { MetaPill, menuItem, SourceRow } from "./source-row";

export type IbkrStatusView = SettingsStatus["ibkr"];

/** The calm sentence for a failed scheduled pull; codes whose text needs params the job did not keep fall back to the generic one. */
function ibkrErrorText(code: string, t: ReturnType<typeof useT>): string {
  const byCode = t.errors.codes[code];
  return errorText({ code: byCode && !byCode.includes("{") ? code : "invest_ibkr_error", message: code }, t);
}

/** "Token expires in N days" from 14 days before the date the user entered, "Token expired" after; null otherwise. */
function expiryText(expiry: SecretsView["ibkr"]["expiry"], t: ReturnType<typeof useT>): string | null {
  const i = t.connections.ibkr;
  if (expiry.state === "expired") return i.expired;
  if (expiry.state !== "soon" || expiry.days == null) return null;
  return expiry.days === 0 ? i.expiresToday : plural(i.expiresIn, expiry.days);
}

/**
 * Interactive Brokers in the Brokerages card. Set up: Flex report pill, state (Active, Waiting for
 * today's statement, Needs attention), when it last synced, positions on the statement date, and the token
 * expiry from 14 days before; Sync now pulls the Flex query (POST /api/invest/sync, provider ibkr). Not set up:
 * "Not set up" and "Set up". "Set up" and the menu's "Replace token" open `IbkrSetupDialog`; the token and
 * the query id are never shown.
 */
export function IbkrRow({ status, secrets, keyInfo }: { status: IbkrStatusView; secrets: SecretsView["ibkr"]; keyInfo: SecretsView["key"] }) {
  const router = useRouter();
  const t = useT();
  const locale = useLocale();
  const c = t.connections;
  const i = c.ibkr;
  const name = t.assets.ibkr.title;
  const [busy, setBusy] = useState(false);
  const [sheet, setSheet] = useState(false);
  const statement = status.lastStatementDate ? dayLabel(status.lastStatementDate, locale) : null;
  const expiry = status.configured ? expiryText(secrets.expiry, t) : null;

  async function sync() {
    setBusy(true);
    try {
      toastInvestSync(await apiFetch<InvestSyncResult>("/api/invest/sync", { json: { provider: "ibkr" } }), t, locale);
    } catch {
      // toasted by apiFetch
    } finally {
      setBusy(false);
      router.refresh();
    }
  }

  const sheetEl = <IbkrSetupDialog open={sheet} onOpenChange={setSheet} ibkr={secrets} keyInfo={keyInfo} />;

  if (!status.configured) {
    return (
      <>
        <SourceRow
          icon={ChartCandlestickIcon}
          testId="ibkr-row"
          name={name}
          meta={[<span key="state">{i.notSetUp}</span>, statement && <span key="last">{fmt(i.lastStatement, { date: statement })}</span>]}
          actions={
            <Button size="sm" onClick={() => setSheet(true)}>
              <SettingsIcon aria-hidden />
              {i.setUp}
            </Button>
          }
          menuLabel={fmt(c.moreActions, { name })}
          phoneMenu
          menu={
            <DropdownMenuItem className={cn(menuItem, "md:hidden")} onSelect={() => setSheet(true)}>
              <SettingsIcon />
              {i.setUp}
            </DropdownMenuItem>
          }
        />
        {sheetEl}
      </>
    );
  }

  const stateText =
    status.state === "error" ? c.status.error : status.state === "waiting" ? i.waiting : status.state === "active" ? c.status.active : null;
  return (
    <>
      <SourceRow
        icon={ChartCandlestickIcon}
        testId="ibkr-row"
        name={
          <Link href={INVESTMENTS_HREF} className="underline-offset-4 hover:underline">
            {name}
          </Link>
        }
        meta={[
          <MetaPill key="flex">{i.flex}</MetaPill>,
          stateText && (
            <span key="state" className={cn(status.state === "error" && "font-medium text-foreground")}>
              {stateText}
            </span>
          ),
          <SyncedAt key="synced" at={status.syncedAt} note={i.schedule} />,
          expiry && (
            <span key="expiry" className={cn(secrets.expiry.state === "expired" && "font-medium text-foreground")} data-testid="ibkr-expiry">
              {expiry}
            </span>
          ),
        ]}
        extra={
          <>
            {statement && <p className="truncate text-meta text-3">{plural(i.positions, status.positions, { date: statement })}</p>}
            {status.state === "error" && status.errorCode && <p className="text-meta text-2">{ibkrErrorText(status.errorCode, t)}</p>}
            {secrets.expiry.state === "expired" && status.state !== "error" && <p className="text-meta text-2">{i.expiredHint}</p>}
          </>
        }
        actions={
          <Button size="sm" onClick={sync} disabled={busy}>
            <RefreshCwIcon aria-hidden />
            {busy ? t.bank.syncing : t.bank.syncNow}
          </Button>
        }
        menuLabel={fmt(c.moreActions, { name })}
        menu={
          <>
            <DropdownMenuItem className={cn(menuItem, "md:hidden")} onSelect={sync} disabled={busy}>
              <RefreshCwIcon />
              {t.bank.syncNow}
            </DropdownMenuItem>
            <DropdownMenuItem className={menuItem} asChild>
              <Link href={INVESTMENTS_HREF}>
                <ChartNoAxesColumnIcon />
                {c.openAssets}
              </Link>
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem className={menuItem} onSelect={() => setSheet(true)}>
              <KeyRoundIcon />
              {i.replaceToken}
            </DropdownMenuItem>
          </>
        }
      />
      {sheetEl}
    </>
  );
}
