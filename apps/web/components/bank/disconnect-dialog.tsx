"use client";

import { dialogSize } from "@/components/ui-kit/dialog-size";
import { disconnectConfirmMatches, disconnectConfirmText } from "@yomi/contracts";
import { useRef, useState } from "react";
import { UnplugIcon } from "lucide-react";
import { Button } from "@/components/ui-kit/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { fmt } from "@/i18n";
import { useT } from "@/i18n/client";
import { rich } from "@/i18n/rich";

/**
 * GitHub-delete-repo style confirmation for /item/remove: the confirm button stays disabled until the
 * institution name is typed exactly. Focus starts on Cancel; Enter only submits on a match.
 * `remote` false: the environment has no secret here, so the login is only forgotten locally.
 */
export function DisconnectDialog({
  open,
  onOpenChange,
  institutionName,
  remote,
  brokerage = false,
  busy,
  onConfirm,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  institutionName: string | null;
  remote: boolean;
  /** A brokerage login: what stays is holdings, not ledger transactions. */
  brokerage?: boolean;
  busy: boolean;
  onConfirm: (confirm: string) => void;
}) {
  const t = useT();
  const d = t.bank.disconnect;
  const [typed, setTyped] = useState("");
  const cancelRef = useRef<HTMLButtonElement>(null);
  const name = disconnectConfirmText(institutionName);
  const ok = disconnectConfirmMatches(institutionName, typed);
  const change = (o: boolean) => {
    if (!o) setTyped("");
    onOpenChange(o);
  };

  return (
    <Dialog
      open={open}
      onOpenChange={change}
    >
      <DialogContent
        className={`gap-3 ${dialogSize("sm")}`}
        data-testid="disconnect-dialog"
        onOpenAutoFocus={(e) => {
          e.preventDefault();
          cancelRef.current?.focus();
        }}
      >
        <DialogHeader>
          <DialogTitle className="text-title">{fmt(d.title, { name })}</DialogTitle>
          <DialogDescription className="sr-only">{d.cannotUndo}</DialogDescription>
        </DialogHeader>
        <ul className="flex list-disc flex-col gap-1.5 pl-5 text-body">
          {remote ? (
            <>
              <li>{fmt(d.remote1, { name })}</li>
              <li>{d.remote2}</li>
            </>
          ) : (
            <>
              <li>{fmt(d.local1, { name })}</li>
              <li>{d.local2}</li>
            </>
          )}
          <li>{brokerage ? d.keptBrokerage : d.kept}</li>
        </ul>
        <form
          className="flex flex-col gap-1.5"
          onSubmit={(e) => {
            e.preventDefault();
            if (ok && !busy) onConfirm(typed.trim());
          }}
        >
          <label htmlFor="disconnect-confirm" className="text-body text-2">
            {rich(d.typeToConfirm, { name: <span className="font-medium text-foreground select-all">{name}</span> })}
          </label>
          <Input
            id="disconnect-confirm"
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
            autoComplete="off"
            spellCheck={false}
            data-testid="disconnect-confirm-input"
          />
          <DialogFooter className="mt-3">
            <Button ref={cancelRef} type="button" variant="outline" onClick={() => change(false)}>
              {t.common.cancel}
            </Button>
            <Button type="submit" variant="danger" disabled={!ok || busy}>
              <UnplugIcon aria-hidden />
              {busy ? t.common.deleting : d.confirm}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
