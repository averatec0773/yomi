"use client";

import type { Category } from "@yomi/contracts";
import { useState } from "react";
import { toast } from "sonner";
import { categoryIcon } from "@/components/category-icon";
import { ListCard } from "@/components/ui-kit/list-card";
import { Switch } from "@/components/ui-kit/switch";
import { fmt } from "@/i18n";
import { categoryLabel } from "@/i18n/categories";
import { useT } from "@/i18n/client";
import { apiFetch } from "@/lib/api";

/**
 * Settings > Categories: the income categories, each with its counts-as-income switch (PATCH /api/categories/:id).
 * A category that does not count is still income: listed and filterable, left out of income totals and the savings rate.
 */
export function CategorySettings({ initial }: { initial: Category[] }) {
  const t = useT();
  const s = t.settings.categories;
  const [items, setItems] = useState(initial);
  const [busy, setBusy] = useState<number | null>(null);

  const set = async (c: Category, countsAsIncome: boolean, undo = true) => {
    setBusy(c.id);
    setItems((list) => list.map((x) => (x.id === c.id ? { ...x, countsAsIncome } : x)));
    try {
      await apiFetch<Category>(`/categories/${c.id}`, { method: "PATCH", json: { countsAsIncome } });
      const name = categoryLabel(c.name, t);
      if (undo) toast.success(fmt(countsAsIncome ? s.counted : s.notCounted, { name }), { action: { label: t.common.undo, onClick: () => void set(c, !countsAsIncome, false) } });
    } catch {
      setItems((list) => list.map((x) => (x.id === c.id ? { ...x, countsAsIncome: !countsAsIncome } : x)));
    } finally {
      setBusy(null);
    }
  };

  return (
    <ListCard heading="h3" title={s.income} aside={s.countsColumn} data-testid="income-categories">
      {items.map((c) => {
        const Icon = categoryIcon(c.name);
        return (
          <div key={c.id} className="px-4 py-1.5 md:px-5">
            <Switch
              checked={c.countsAsIncome}
              disabled={busy === c.id}
              onChange={(on) => void set(c, on)}
              label={
                <span className="flex items-center gap-2">
                  <Icon className="size-4 shrink-0 text-2" aria-hidden />
                  {categoryLabel(c.name, t)}
                </span>
              }
            />
          </div>
        );
      })}
    </ListCard>
  );
}
