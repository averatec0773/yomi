"use client";

import { EllipsisIcon, FlaskConicalIcon, KeyRoundIcon, LandmarkIcon } from "lucide-react";
import type { BankEnvironment } from "@yomi/contracts";
import { Button } from "@/components/ui-kit/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { fmt } from "@/i18n";
import { useLocale, useT } from "@/i18n/client";
import { ConnectBankButton, useConnectFlow } from "./connect-bank-button";
import { DEVELOPER_KEYS_ID } from "./developer-keys";

/**
 * Settings > Connections header: "Connect bank" and "Connect brokerage" (40px outline), an overflow menu
 * with the other environment ("Connect a test bank (Sandbox)" and its test login), and one quiet meta
 * line with the environments and the Plaid Item cost.
 */
export function ConnectActions({ environments, defaultEnvironment }: { environments: BankEnvironment[]; defaultEnvironment: BankEnvironment }) {
  const t = useT();
  const locale = useLocale();
  const c = t.connections;
  const other = environments.find((e) => e !== defaultEnvironment) ?? null;
  const list = new Intl.ListFormat(locale, { type: "conjunction" }).format(environments.map((e) => t.bank.envs[e] ?? e));
  return (
    <div className="flex flex-col gap-2" data-testid="connect-actions">
      <div className="flex flex-wrap items-center gap-2">
        <ConnectBankButton environment={defaultEnvironment} className="max-md:px-3" />
        <ConnectBankButton environment={defaultEnvironment} purpose="brokerage" className="max-md:px-3" />
        {/* Phones have no room for the menu beside both buttons: it moves to the end of the meta line. */}
        {other && (
          <span className="max-md:hidden">
            <OtherEnvironmentMenu environment={other} />
          </span>
        )}
      </div>
      <div className="flex items-center gap-2">
        <p className="min-w-0 flex-1 text-meta text-3" data-testid="plaid-meta">
          {fmt(c.plaidMeta, { list })}
        </p>
        {other && (
          <span className="-my-1 md:hidden">
            <OtherEnvironmentMenu environment={other} />
          </span>
        )}
      </div>
    </div>
  );
}

function OtherEnvironmentMenu({ environment }: { environment: BankEnvironment }) {
  const t = useT();
  const c = t.connections;
  const flow = useConnectFlow({ environment, confirmSandbox: true });
  const sandbox = environment === "sandbox";
  const Icon = sandbox ? FlaskConicalIcon : LandmarkIcon;
  return (
    <DropdownMenu modal={false}>
      <DropdownMenuTrigger asChild>
        <Button size="icon" variant="ghost" aria-label={c.moreWays} disabled={flow.busy} title={flow.busyText ?? undefined}>
          <EllipsisIcon aria-hidden />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-80 rounded-xl bg-raised p-1 shadow-dialog ring-1 ring-line-strong">
        <DropdownMenuItem className="items-start gap-2 py-2 text-body [&_svg]:mt-0.5 [&_svg]:text-2" onSelect={flow.open}>
          <Icon />
          <span className="flex flex-col gap-0.5">
            <span>{sandbox ? t.bank.connectSandbox : t.bank.connectProduction}</span>
            <span className="text-meta text-2">{sandbox ? c.sandboxHint : c.productionHint}</span>
          </span>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/**
 * Plaid not configured: one calm line and "Add developer keys", which opens the Developer keys group at the
 * bottom of the tab (URL hash #developer-keys).
 */
export function PlaidSetup() {
  const t = useT();
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-2" data-testid="plaid-setup">
      <p className="min-w-0 flex-1 basis-60 text-body text-2">{t.connections.plaidOff}</p>
      <Button asChild>
        <a
          href={`#${DEVELOPER_KEYS_ID}`}
          onClick={() => {
            // Same hash twice does not fire hashchange: open and scroll explicitly.
            requestAnimationFrame(() => {
              window.dispatchEvent(new HashChangeEvent("hashchange"));
              document.getElementById(DEVELOPER_KEYS_ID)?.scrollIntoView({ behavior: "smooth", block: "start" });
            });
          }}
        >
          <KeyRoundIcon aria-hidden />
          {t.secrets.plaid.addKeys}
        </a>
      </Button>
    </div>
  );
}
