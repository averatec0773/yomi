"use client";

import { InboxIcon } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui-kit/button";
import { type Plural, plural } from "@/i18n";
import { useT } from "@/i18n/client";
import { cn } from "@/lib/utils";
import { ReviewSheet } from "./review-sheet";

/**
 * The quiet line that leads to the review queue: Inbox icon, "3 captures need a look", text button "Review" (opens the
 * sheet). Not a card, no badge; nothing while the queue is empty. `text` picks the wording (Transactions, the import
 * receipt).
 */
export function ReviewLine({ count, text, className }: { count: number; text?: Plural; className?: string }) {
  const c = useT().capture;
  const [open, setOpen] = useState(false);
  return (
    <>
      {count > 0 && (
        <p className={cn("flex flex-wrap items-center gap-x-2.5 gap-y-1 text-body text-2", className)} data-testid="review-line">
          <InboxIcon className="size-4 shrink-0" aria-hidden />
          <span>{plural(text ?? c.line, count)}</span>
          <Button variant="quiet" className="text-primary" onClick={() => setOpen(true)}>
            {c.review}
          </Button>
        </p>
      )}
      <ReviewSheet open={open} onOpenChange={setOpen} />
    </>
  );
}
