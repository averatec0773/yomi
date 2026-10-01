"use client";

import { TagsIcon } from "lucide-react";
import type { RecategorizeResult } from "@yomi/contracts";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { Button } from "@/components/ui-kit/button";
import { fmt } from "@/i18n";
import { useT } from "@/i18n/client";
import { apiFetch } from "@/lib/api";

/** Maintenance: re-run merchant cleanup and categorization on rows the user has not edited. */
export function Recategorize() {
  const router = useRouter();
  const t = useT().import.recategorize;
  const [pending, setPending] = useState(false);
  const [result, setResult] = useState<RecategorizeResult | null>(null);

  async function run() {
    setPending(true);
    try {
      setResult(await apiFetch<RecategorizeResult>("/api/ledger/recategorize", { method: "POST" }));
      router.refresh();
    } catch {
      // toasted by apiFetch
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="flex flex-col gap-2">
      <div>
        <Button onClick={run} disabled={pending} className="h-auto min-h-10 py-2 whitespace-normal text-left">
          <TagsIcon aria-hidden />
          {pending ? t.running : t.button}
        </Button>
      </div>
      {result && (
        <p className="text-meta text-2" role="status">
          {fmt(t.result, {
            scanned: result.scanned,
            category: result.categoryChanged,
            merchant: result.merchantChanged,
            kind: result.kindChanged,
          })}
        </p>
      )}
    </div>
  );
}
