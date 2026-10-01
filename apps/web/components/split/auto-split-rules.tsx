"use client";

import { SplitIcon, XIcon } from "lucide-react";
import type { MerchantRule } from "@yomi/contracts";
import { toast } from "sonner";
import { Button } from "@/components/ui-kit/button";
import { EmptyState } from "@/components/ui-kit/empty-state";
import { ListCard } from "@/components/ui-kit/list-card";
import { fmt, plural } from "@/i18n";
import { useT } from "@/i18n/client";
import { apiFetch } from "@/lib/api";
import { useMutation } from "./ui";

/** "Automatic split rules": merchants whose new rows are split on import. Removing turns the rule off (participants stay a chip hint). */
export function AutoSplitRules({ rules }: { rules: MerchantRule[] }) {
  const { run, busy } = useMutation();
  const t = useT();
  const ar = t.split.autoRules;

  async function setEnabled(rule: MerchantRule, enabled: boolean) {
    return run(() =>
      apiFetch<MerchantRule>("/merchant-rules/auto-split", {
        json: { merchant: rule.merchant, participantIds: rule.participants.map((p) => p.id), enabled },
      }),
    );
  }

  return (
    <ListCard icon={SplitIcon} title={ar.title} count={rules.length || undefined}>
      {rules.length === 0 ? (
        <EmptyState variant="inline" icon={SplitIcon}>
          {ar.none}
        </EmptyState>
      ) : (
        <ul className="divide-y divide-line-soft">
          <li className="px-4 py-3 text-meta text-2 md:px-5">{ar.has}</li>
          {rules.map((r) => (
            <li key={r.merchant} className="flex min-h-12 items-center gap-3 px-4 py-1.5 text-body md:px-5">
              <span className="min-w-0 flex-1 truncate">
                <span className="font-medium">{r.merchant}</span>
                <span className="text-2">{fmt(ar.withPeople, { names: r.participants.map((p) => p.name).join(t.common.listSep) || ar.nobody })}</span>
                <span className="text-meta text-2">{plural(ar.rowCount, r.rowCount)}</span>
              </span>
              <Button
                variant="ghost"
                size="sm"
                disabled={busy}
                aria-label={fmt(ar.removeAria, { merchant: r.merchant })}
                onClick={async () => {
                  const out = await setEnabled(r, false);
                  if (!out) return;
                  toast(fmt(ar.removed, { merchant: r.merchant }), {
                    action: { label: t.common.undo, onClick: () => void setEnabled(r, true) },
                  });
                }}
              >
                <XIcon aria-hidden />
                {t.common.remove}
              </Button>
            </li>
          ))}
        </ul>
      )}
    </ListCard>
  );
}
