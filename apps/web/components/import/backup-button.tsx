"use client";

import { DatabaseBackupIcon } from "lucide-react";
import type { BackupResult } from "@yomi/contracts";
import { useState } from "react";
import { Button } from "@/components/ui-kit/button";
import { useT } from "@/i18n/client";
import { rich } from "@/i18n/rich";
import { apiFetch } from "@/lib/api";

/** Maintenance: write a tarball of the PGlite ledger directory to data/backups/ and show where it went. */
export function BackupButton() {
  const t = useT().import.backup;
  const [pending, setPending] = useState(false);
  const [result, setResult] = useState<BackupResult | null>(null);

  async function run() {
    setPending(true);
    try {
      setResult(await apiFetch<BackupResult>("/api/maintenance/backup", { method: "POST" }));
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
          <DatabaseBackupIcon aria-hidden />
          {pending ? t.running : t.button}
        </Button>
      </div>
      {result && (
        <p className="text-meta text-2 break-all" role="status">
          {rich(t.done, { path: <span className="font-mono text-foreground">{result.path}</span> })}
        </p>
      )}
    </div>
  );
}
