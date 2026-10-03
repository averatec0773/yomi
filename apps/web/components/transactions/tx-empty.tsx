"use client";

// What the transaction list shows instead of rows: all split, nothing imported yet, or no match.

import { ReceiptTextIcon, SearchXIcon, SplitIcon } from "lucide-react";
import Link from "next/link";
import { EmptyState } from "@/components/ui-kit/empty-state";
import { useT } from "@/i18n/client";

export function TxEmpty({ unsplit, monthHasData, filtered, isRange }: { unsplit: boolean; monthHasData: boolean; filtered: boolean; isRange: boolean }) {
  const t = useT();
  return unsplit && monthHasData ? (
    <EmptyState
      icon={SplitIcon}
      action={
        <Link href="/split" className="text-primary underline-offset-2 hover:underline">
          {t.transactions.backToSplit}
        </Link>
      }
    >
      {isRange ? t.transactions.allSplitRange : t.transactions.allSplitMonth}
    </EmptyState>
  ) : !monthHasData && !filtered ? (
    <EmptyState
      icon={ReceiptTextIcon}
      action={
        <Link href="/import" className="text-primary underline-offset-2 hover:underline">
          {t.transactions.goImport}
        </Link>
      }
    >
      {isRange ? t.transactions.emptyRange : t.transactions.emptyMonth}
    </EmptyState>
  ) : (
    <EmptyState icon={SearchXIcon}>{t.transactions.noMatch}</EmptyState>
  );
}
