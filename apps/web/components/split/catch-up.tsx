import type { UnsplitMonth } from "@yomi/contracts";
import { ChevronRightIcon, HistoryIcon } from "lucide-react";
import Link from "next/link";
import { Fragment } from "react";
import { Money } from "@/components/money";
import { fmt, plural } from "@/i18n";
import type { Dictionary } from "@/i18n/en";
import { rich } from "@/i18n/rich";
import { getI18n } from "@/i18n/server";
import { shortMonth } from "@/lib/period";
import type { Locale } from "@/i18n/config";
import { Section } from "./ui";

const SHOW = 12;

function MonthLine({ m, t, locale }: { m: UnsplitMonth; t: Dictionary; locale: Locale }) {
  return (
    <li className="border-t border-line-soft">
      <Link
        href={`/transactions?month=${m.month}&unsplit=1`}
        aria-label={fmt(t.split.catchUp.aria, { month: m.month, count: m.count })}
        className="group -mx-1 flex min-h-11 items-center gap-3 rounded-md px-1 py-1.5 transition-colors duration-[120ms] hover:bg-tile/50"
      >
        <span className="w-[120px] shrink-0 text-body">{shortMonth(m.month, locale, true)}</span>
        <span className="flex min-w-0 flex-1 flex-wrap items-baseline gap-x-1.5 text-meta text-2">
          <span data-testid="unsplit-count">
            {rich(t.split.catchUp.detail, { count: <span className="num">{m.count}</span> })}
          </span>
          {m.totals.map((total) => (
            <Fragment key={total.currency}>
              <span>·</span>
              <Money minor={total.amountMinor} currency={total.currency} tone="muted" />
            </Fragment>
          ))}
          {m.suggestedCount > 0 && <span className="text-meta text-2">{plural(t.split.catchUp.suggested, m.suggestedCount)}</span>}
        </span>
        <ChevronRightIcon className="size-4 shrink-0 text-2 group-hover:text-foreground" aria-hidden />
      </Link>
    </li>
  );
}

/** Catch up on old bills: months with unsplit expenses, each opening the transaction list filtered to them. */
export async function CatchUp({ months }: { months: UnsplitMonth[] }) {
  if (months.length === 0) return null;
  const { locale, t } = await getI18n();
  const cu = t.split.catchUp;
  const total = months.reduce((n, m) => n + m.count, 0);
  const rest = months.slice(SHOW);
  return (
    <Section card icon={<HistoryIcon />} title={cu.title} count={total} aside={cu.hint}>
      <ul aria-label={cu.listLabel}>
        {months.slice(0, SHOW).map((m) => (
          <MonthLine key={m.month} m={m} t={t} locale={locale} />
        ))}
      </ul>
      {rest.length > 0 && (
        <details className="group">
          <summary className="cursor-pointer list-none py-2 text-meta text-2 hover:text-foreground [&::-webkit-details-marker]:hidden">
            <span className="group-open:hidden">{plural(cu.earlier, rest.length)}</span>
            <span className="hidden group-open:inline">{t.common.collapse}</span>
          </summary>
          <ul>
            {rest.map((m) => (
              <MonthLine key={m.month} m={m} t={t} locale={locale} />
            ))}
          </ul>
        </details>
      )}
    </Section>
  );
}
