"use client";

import { CheckIcon, FunnelIcon, SplitIcon, TagIcon, UsersIcon, XIcon } from "lucide-react";
import { categoryIcon } from "@/components/category-icon";
import { FilterChip } from "@/components/ui-kit/filter-chip";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { fmt, plural } from "@/i18n";
import { categoryLabel } from "@/i18n/categories";
import { useT } from "@/i18n/client";
import { cn } from "@/lib/utils";
import type { Category, Participant, TxFilters } from "./types";
import { useUpdateParams } from "./use-params";

const itemCls = "h-9 gap-2 text-body";
const menuCls = "max-h-80 min-w-52 rounded-xl bg-raised p-1 shadow-dialog ring-1 ring-line-strong";

/**
 * Filter chips under the spend strip (an icon on every chip): category, person, "Not split", more filters
 * (uncategorized only, show closed and duplicates). The URL is the only state. Right: counts and "Clear filters".
 */
export function TxToolbar({
  filters,
  categories,
  participants,
  count,
  notSplit,
  hiddenCount,
}: {
  filters: TxFilters;
  categories: Category[];
  participants: Participant[];
  count: number;
  /** Rows on screen that are my expenses and not split yet (shown when there is someone to split with). */
  notSplit: number;
  hiddenCount: number;
}) {
  const t = useT();
  const tb = t.transactions.toolbar;
  const { update, pending } = useUpdateParams();

  const expense = categories.filter((c) => c.kind === "expense");
  const income = categories.filter((c) => c.kind === "income");
  const others = participants.filter((p) => !p.isSelf);
  const category = categories.find((c) => c.id === filters.categoryId);
  const person = others.find((p) => p.id === filters.participantId);
  const moreOn = filters.uncategorized || filters.showAll;
  const filtered = Boolean(filters.q || filters.categoryId || filters.participantId || filters.uncategorized || filters.unsplit);

  const categoryItem = (c: Category) => {
    const Icon = categoryIcon(c.name);
    return (
      <DropdownMenuItem
        key={c.id}
        className={cn(itemCls, c.id === filters.categoryId && "text-primary")}
        onSelect={() => update({ categoryId: String(c.id), uncategorized: undefined })}
      >
        <Icon className="size-4 text-2" />
        <span className="flex-1 truncate">{categoryLabel(c.name, t)}</span>
        {c.id === filters.categoryId && <CheckIcon className="size-4" />}
      </DropdownMenuItem>
    );
  };

  return (
    <div className="flex items-center gap-2">
      <div className="-mx-gutter flex min-w-0 flex-1 items-center gap-2 overflow-x-auto px-gutter [scrollbar-width:none] md:mx-0 md:flex-wrap md:overflow-visible md:px-0 [&::-webkit-scrollbar]:hidden">
        <DropdownMenu modal={false}>
          <DropdownMenuTrigger asChild>
            <FilterChip icon={TagIcon} menu active={Boolean(category)} aria-label={tb.filterCategory}>
              {category ? categoryLabel(category.name, t) : tb.allCategories}
            </FilterChip>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className={menuCls}>
            <DropdownMenuItem className={itemCls} onSelect={() => update({ categoryId: undefined })}>
              <TagIcon className="size-4 text-2" />
              <span className="flex-1">{tb.allCategories}</span>
              {!category && <CheckIcon className="size-4" />}
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuLabel className="text-meta text-2">{t.common.expense}</DropdownMenuLabel>
            {expense.map(categoryItem)}
            {income.length > 0 && (
              <>
                <DropdownMenuSeparator />
                <DropdownMenuLabel className="text-meta text-2">{t.common.income}</DropdownMenuLabel>
                {income.map(categoryItem)}
              </>
            )}
          </DropdownMenuContent>
        </DropdownMenu>

        {others.length > 0 && (
          <DropdownMenu modal={false}>
            <DropdownMenuTrigger asChild>
              <FilterChip icon={UsersIcon} menu active={Boolean(person)} aria-label={tb.filterPerson}>
                {person ? fmt(tb.withPerson, { name: person.name }) : tb.allPeople}
              </FilterChip>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className={menuCls}>
              <DropdownMenuItem className={itemCls} onSelect={() => update({ participantId: undefined })}>
                <UsersIcon className="size-4 text-2" />
                <span className="flex-1">{tb.allPeople}</span>
                {!person && <CheckIcon className="size-4" />}
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              {others.map((p) => (
                <DropdownMenuItem
                  key={p.id}
                  className={cn(itemCls, p.id === filters.participantId && "text-primary")}
                  onSelect={() => update({ participantId: String(p.id) })}
                >
                  <span aria-hidden className="inline-flex size-5 items-center justify-center rounded-full bg-tile text-hint font-semibold text-2">
                    {p.name.slice(0, 1).toUpperCase()}
                  </span>
                  <span className="flex-1 truncate">{fmt(tb.withPerson, { name: p.name })}</span>
                  {p.id === filters.participantId && <CheckIcon className="size-4" />}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        )}

        {others.length > 0 && (
          <FilterChip
            icon={SplitIcon}
            active={filters.unsplit}
            aria-pressed={filters.unsplit}
            onClick={() => update({ unsplit: filters.unsplit ? undefined : "1" })}
          >
            {tb.onlyUnsplit}
          </FilterChip>
        )}

        <DropdownMenu modal={false}>
          <DropdownMenuTrigger asChild>
            <FilterChip icon={FunnelIcon} menu active={moreOn}>
              {tb.moreFilters}
            </FilterChip>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className={menuCls}>
            <DropdownMenuCheckboxItem
              className={itemCls}
              checked={filters.uncategorized}
              onCheckedChange={(v) => update({ uncategorized: v ? "1" : undefined, categoryId: undefined })}
            >
              {tb.uncategorizedOnly}
            </DropdownMenuCheckboxItem>
            <DropdownMenuCheckboxItem
              className={itemCls}
              checked={filters.showAll}
              onCheckedChange={(v) => update({ show: v ? "all" : undefined })}
            >
              {tb.showAll}
            </DropdownMenuCheckboxItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      <p
        className={cn("hidden shrink-0 items-center gap-2 text-meta whitespace-nowrap text-2 transition-opacity md:flex", pending && "opacity-50")}
        aria-live="polite"
      >
        <span className="num">
          {plural(tb.count, count)}
          {others.length > 0 && notSplit > 0 && !filters.unsplit && ` · ${plural(t.transactions.notSplit, notSplit)}`}
          {!filters.showAll && hiddenCount > 0 && <span className="text-3">{fmt(tb.hidden, { count: hiddenCount })}</span>}
        </span>
        {filtered && (
          <button
            type="button"
            className="hit relative inline-flex items-center gap-1 rounded-sm text-2 underline-offset-2 hover:text-foreground hover:underline"
            onClick={() => update({ q: undefined, categoryId: undefined, participantId: undefined, uncategorized: undefined, unsplit: undefined })}
          >
            <XIcon className="size-3.5" aria-hidden />
            {tb.clearFilters}
          </button>
        )}
      </p>
    </div>
  );
}
