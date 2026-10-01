"use client";

import type { BankEnvironment } from "@yomi/contracts";
import { useT } from "@/i18n/client";
import { ConnectBankButton } from "./connect-bank-button";

/** "Connect a brokerage" (Plaid Link with purpose brokerage) and the one-line cost under it. Used on /assets and /import. */
export function ConnectBrokerage({ environment, primary = false }: { environment: BankEnvironment; primary?: boolean }) {
  const t = useT();
  return (
    <div className="flex flex-col items-start gap-1.5" data-testid="connect-brokerage">
      <ConnectBankButton environment={environment} purpose="brokerage" variant={primary ? "primary" : "outline"} />
      <p className="text-meta text-2">{t.bank.connect.brokerageConsequence}</p>
    </div>
  );
}
