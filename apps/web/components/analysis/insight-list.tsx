"use client";

import { type ReactNode, useState } from "react";
import { fmt } from "@/i18n";
import { useT } from "@/i18n/client";

/** Lines shown before "+N more"; a single hidden line is shown instead of the button. */
const VISIBLE = 3;

/** A short list of one-line observations under a thin divider; the rest expand in place. */
export function InsightList({ items, label, testId }: { items: ReactNode[]; label: string; testId?: string }) {
  const a = useT().analysis;
  const [open, setOpen] = useState(false);
  const capped = items.length > VISIBLE + 1;
  const shown = capped && !open ? items.slice(0, VISIBLE) : items;
  return (
    <div className="mt-2 flex flex-col items-start gap-2 border-t border-line-soft pt-3" data-testid={testId}>
      <ul aria-label={label} className="flex flex-col gap-1.5 self-stretch text-body">
        {shown}
      </ul>
      {capped && (
        <button
          type="button"
          aria-expanded={open}
          onClick={() => setOpen(!open)}
          className="hit relative rounded-sm text-meta text-2 underline-offset-4 outline-none hover:text-foreground hover:underline focus-visible:ring-2 focus-visible:ring-ring/50"
        >
          {open ? a.less : fmt(a.more, { count: items.length - VISIBLE })}
        </button>
      )}
    </div>
  );
}
