import type { CategoryShare, IncomeCategoryShare } from "@yomi/core";
import Link from "next/link";
import { categoryIcon } from "@/components/category-icon";
import { Money } from "@/components/money";
import { plural } from "@/i18n";
import { categoryLabel } from "@/i18n/categories";
import { getI18n } from "@/i18n/server";

function percent(bp: number): string {
  if (bp > 0 && bp < 100) return "<1%";
  return `${Math.round(bp / 100)}%`;
}

/**
 * Ranked category shares with thin inline bars; each row opens the filtered transaction list. Income lists categories
 * that count first, then the rest under a thin "Not counted" divider, and links to income rows only.
 */
export async function CategoryList({
  period,
  currency,
  items,
  income = false,
}: {
  /** Query params naming the period on /transactions: `{ month }` or `{ from, to }`. */
  period: Record<string, string>;
  currency: string;
  items: (CategoryShare | IncomeCategoryShare)[];
  income?: boolean;
}) {
  const { t } = await getI18n();
  if (items.length === 0) return <p className="px-4 py-4 text-body text-2 md:px-5">{income ? t.analysis.noIncome : t.analysis.noSpending}</p>;
  const top = Math.max(...items.map((c) => c.share), 1);
  const firstNotCounted = items.findIndex((c) => "counted" in c && !c.counted);

  return (
    <ul className="divide-y divide-line-soft">
      {items.map((c, i) => {
        const q = new URLSearchParams(period);
        if (income) q.set("kind", "income");
        if (c.categoryId == null) q.set("uncategorized", "1");
        else q.set("categoryId", String(c.categoryId));
        const CategoryIcon = categoryIcon(c.categoryId == null ? null : c.name);
        return (
          <li key={c.categoryId ?? "none"}>
            {i === firstNotCounted && <p className="px-4 pt-3 pb-1 text-meta text-3 md:px-5">{t.analysis.notCounted}</p>}
            <Link
              href={`/transactions?${q.toString()}`}
              className="grid h-12 grid-cols-[7rem_minmax(0,1fr)_2.75rem_auto] items-center gap-3 px-4 transition-colors duration-[120ms] hover:bg-sunken sm:grid-cols-[9rem_minmax(0,1fr)_2.75rem_6.5rem_3rem] md:px-5"
            >
              <span className="flex min-w-0 items-center gap-2">
                <CategoryIcon className="size-4 shrink-0 text-2" aria-hidden />
                <span className="truncate">{c.categoryId == null ? t.common.uncategorized : categoryLabel(c.name, t)}</span>
              </span>
              <span className="h-1 rounded-full bg-sunken" aria-hidden>
                <span
                  className="block h-full rounded-full bg-foreground/30"
                  style={{ width: `${Math.max((c.share / top) * 100, c.minor > 0 ? 1.5 : 0)}%` }}
                />
              </span>
              <span className="num text-meta text-2">{percent(c.share)}</span>
              <Money minor={c.minor} currency={currency} />
              <span className="num hidden text-meta text-3 sm:block">{plural(t.analysis.categoryCount, c.count)}</span>
            </Link>
          </li>
        );
      })}
    </ul>
  );
}
