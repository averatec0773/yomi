"use client";

import { dialogSize } from "@/components/ui-kit/dialog-size";
import { CheckIcon, Undo2Icon } from "lucide-react";
import type { RevertResult } from "@yomi/contracts";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { Button } from "@/components/ui-kit/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { fmt, plural } from "@/i18n";
import { useT } from "@/i18n/client";
import { apiFetch } from "@/lib/api";

/** Revert with a confirm dialog; shows {deleted, keptEdited} before closing. */
export function RevertBatch({ id, fileName, inserted }: { id: number; fileName: string; inserted: number }) {
  const router = useRouter();
  const t = useT();
  const rt = t.import.revert;
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const [result, setResult] = useState<RevertResult | null>(null);

  async function revert() {
    setPending(true);
    try {
      // Refresh on close: the row (and this dialog) unmounts once the batch reads as reverted.
      setResult(await apiFetch<RevertResult>(`/api/import/batches/${id}/revert`, { method: "POST" }));
    } catch {
      // toasted by apiFetch
    } finally {
      setPending(false);
    }
  }

  function change(v: boolean) {
    setOpen(v);
    if (!v && result) {
      setResult(null);
      router.refresh();
    }
  }

  return (
    <Dialog open={open} onOpenChange={change}>
      <DialogTrigger asChild>
        <Button size="sm" variant="ghost">
          <Undo2Icon aria-hidden />
          {rt.button}
        </Button>
      </DialogTrigger>
      <DialogContent className={`shadow-dialog ${dialogSize("sm")}`}>
        <DialogHeader>
          <DialogTitle className="text-title font-medium">{fmt(rt.title, { id })}</DialogTitle>
          <DialogDescription className="text-body text-2">
            {result ? (
              <>
                {plural(rt.deleted, result.deleted)}
                {result.keptEdited > 0 ? plural(rt.keptEdited, result.keptEdited) : rt.deletedEnd}
              </>
            ) : (
              <>
                {fmt(rt.body, { file: fileName, count: inserted })}
              </>
            )}
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          {result ? (
            <Button variant="primary" onClick={() => change(false)}>
              <CheckIcon aria-hidden />
              {rt.ok}
            </Button>
          ) : (
            <>
              <Button variant="ghost" onClick={() => change(false)} disabled={pending}>
                {t.common.cancel}
              </Button>
              <Button variant="primary" onClick={revert} disabled={pending}>
                <Undo2Icon aria-hidden />
                {rt.confirm}
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
