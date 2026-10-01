import type { AccountBalanceView } from "@yomi/core";
import { BanknoteIcon, CreditCardIcon, LandmarkIcon, type LucideIcon, WalletIcon } from "lucide-react";
import type { ReactNode } from "react";
import { Money } from "@/components/money";
import { IconTile } from "@/components/ui-kit/icon-tile";
import { fmt } from "@/i18n";
import { accountLabel } from "@/i18n/accounts";
import type { Locale } from "@/i18n/config";
import type { Dictionary } from "@/i18n/en";
import { rich } from "@/i18n/rich";
import { dayLabel } from "@/lib/month";

export function accountIcon(kind: string): LucideIcon {
  if (kind === "credit_card") return CreditCardIcon;
  if (kind === "wallet") return WalletIcon;
  if (kind === "cash") return BanknoteIcon;
  return LandmarkIcon;
}

/** "Balance from bank · Sep 29", "Statement balance · Sep 24", "Starting balance Sep 1 + transactions". */
export function sourceText(a: AccountBalanceView, t: Dictionary, locale: Locale): string {
  const s = a.balances[0];
  if (!s?.source) return t.assets.source.none;
  const date = s.sourceAsOf ? dayLabel(s.sourceAsOf, locale) : "";
  return fmt(t.assets.source[s.source], { date });
}

/**
 * One account on /assets: icon tile, name, where the balance comes from and its day, then the balance per
 * currency and the change over 30 days. Cards are what is owed, in clay. `action` sits under the numbers
 * (Set a starting balance). Server component.
 */
export function AccountRow({ account, t, locale, action }: { account: AccountBalanceView; t: Dictionary; locale: Locale; action?: ReactNode }) {
  const a = t.assets;
  const card = account.class === "card";
  const multi = account.balances.length > 1;
  return (
    <div className="flex min-h-row-phone items-center gap-3.5 px-4 py-2.5 md:min-h-row md:px-5" data-testid="assets-account-row" data-account={account.id}>
      <IconTile icon={accountIcon(account.kind)} size="responsive" />
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="truncate text-body font-medium">{accountLabel(account.name, t)}</span>
        <span className="truncate text-meta text-2">{sourceText(account, t, locale)}</span>
      </div>
      <div className="flex shrink-0 flex-col items-end gap-0.5">
        {account.balances.map((b) => (
          <span key={b.currency} className="text-body font-medium">
            <Money minor={b.balanceMinor} currency={b.currency} showCode={multi} tone={card && b.balanceMinor < 0 ? "neg" : undefined} />
          </span>
        ))}
        {account.balances.length > 0 && (
          <span className="text-hint text-3">
            {card && account.balances[0]!.balanceMinor < 0 ? (
              a.owed
            ) : account.balances[0]!.changeMinor == null ? null : account.balances[0]!.changeMinor === 0 ? (
              a.noChange
            ) : (
              rich(a.changeIn30, { amount: <Money minor={account.balances[0]!.changeMinor} currency={account.balances[0]!.currency} sign="signed" /> })
            )}
          </span>
        )}
        {action}
      </div>
    </div>
  );
}
