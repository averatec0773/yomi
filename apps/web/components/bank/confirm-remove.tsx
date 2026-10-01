"use client";

import { Trash2Icon } from "lucide-react";
import { useRef } from "react";
import { Button } from "@/components/ui-kit/button";
import { dialogSize } from "@/components/ui-kit/dialog-size";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useT } from "@/i18n/client";

/** sm confirmation before a saved secret is removed. Focus starts on the keep button. */
export function ConfirmRemove({
  open,
  onOpenChange,
  title,
  body,
  confirmLabel,
  busy,
  onConfirm,
  testId,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  body: string;
  confirmLabel: string;
  busy: boolean;
  onConfirm: () => void;
  testId?: string;
}) {
  const t = useT();
  const keep = useRef<HTMLButtonElement>(null);
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className={`gap-3 ${dialogSize("sm")}`}
        data-testid={testId}
        onOpenAutoFocus={(e) => {
          e.preventDefault();
          keep.current?.focus();
        }}
      >
        <DialogHeader>
          <DialogTitle className="text-title">{title}</DialogTitle>
          <DialogDescription className="text-body text-2">{body}</DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button ref={keep} variant="ghost" onClick={() => onOpenChange(false)}>
            {t.secrets.removeCancel}
          </Button>
          <Button variant="danger" onClick={onConfirm} disabled={busy}>
            <Trash2Icon aria-hidden />
            {confirmLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
