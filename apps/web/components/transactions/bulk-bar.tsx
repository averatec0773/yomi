"use client";

import { ArrowLeftRightIcon, ChevronDownIcon, SplitIcon, TagIcon } from "lucide-react";
import { BulkBar as Bar, bulkAction } from "@/components/ui-kit/bulk-bar";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { categoryLabel } from "@/i18n/categories";
import { useT } from "@/i18n/client";
import { AaBulkPopover } from "./aa-popover";
import type { Category, Participant, Tx } from "./types";

/** The Transactions selection bar: N selected · Split… · Category · Mark as transfer · Clear selection. */
export function BulkBar({
  count,
  rows,
  others,
  selfId,
  categories,
  onApply,
  onUnsplit,
  onAdd,
  onCategory,
  onTransfer,
  onClear,
}: {
  count: number;
  rows: Tx[];
  others: Participant[];
  selfId: number;
  categories: Category[];
  onApply: (participantIds: number[]) => void;
  onUnsplit: () => void;
  onAdd: (name: string) => Promise<Participant | null>;
  onCategory: (categoryId: number) => void;
  onTransfer: () => void;
  onClear: () => void;
}) {
  const t = useT();
  const b = t.transactions.bulk;
  const [before, after] = b.selected.split("{count}");
  const groups = [
    { label: t.common.expense, items: categories.filter((c) => c.kind === "expense") },
    { label: t.common.income, items: categories.filter((c) => c.kind === "income") },
  ];
  return (
    <Bar
      label={b.label}
      clearLabel={b.clear}
      onClear={onClear}
      count={
        <>
          {before}
          <span className="num text-foreground">{count}</span>
          {after}
        </>
      }
    >
      <AaBulkPopover rows={rows} count={count} others={others} selfId={selfId} onApply={onApply} onClear={onUnsplit} onAdd={onAdd}>
        <button type="button" className={bulkAction}>
          <SplitIcon aria-hidden />
          {b.split}
        </button>
      </AaBulkPopover>
      <DropdownMenu modal={false}>
        <DropdownMenuTrigger asChild>
          <button type="button" className={bulkAction}>
            <TagIcon aria-hidden />
            {b.category}
            <ChevronDownIcon aria-hidden className="size-3.5!" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent side="top" align="center" className="max-h-80 w-56 shadow-dialog">
          {groups.map((g) => (
            <div key={g.label}>
              <DropdownMenuLabel className="px-2 pt-1.5 text-meta font-normal text-2">{g.label}</DropdownMenuLabel>
              <div className="grid grid-cols-2 gap-0.5">
                {g.items.map((c) => (
                  <DropdownMenuItem key={c.id} className="h-9 px-2 text-body" onSelect={() => onCategory(c.id)}>
                    {categoryLabel(c.name, t)}
                  </DropdownMenuItem>
                ))}
              </div>
            </div>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
      <button type="button" className={bulkAction} onClick={onTransfer}>
        <ArrowLeftRightIcon aria-hidden />
        {b.markTransfer}
      </button>
    </Bar>
  );
}
