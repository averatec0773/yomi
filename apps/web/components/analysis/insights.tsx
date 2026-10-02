import type { AnalysisCurrency, AnalysisReport, SourceFreshness } from "@yomi/core";
import {
  AlertCircleIcon,
  ArrowDownWideNarrowIcon,
  CopyIcon,
  HourglassIcon,
  InboxIcon,
  LightbulbIcon,
  ListIcon,
  type LucideIcon,
  MinusIcon,
  StoreIcon,
  TargetIcon,
  TrendingDownIcon,
  TrendingUpIcon,
  WalletIcon,
} from "lucide-react";
import Link from "next/link";
import type { ReactNode } from "react";
import { categoryIcon } from "@/components/category-icon";
import { Money } from "@/components/money";
import { ListCard } from "@/components/ui-kit/list-card";
import { fmt, plural } from "@/i18n";
import { categoryLabel } from "@/i18n/categories";
import type { Locale } from "@/i18n/config";
import type { Dictionary } from "@/i18n/en";
import { rich } from "@/i18n/rich";
import { dayLabel } from "@/lib/month";

/** Everything a block needs to write its sentences. */
export interface InsightContext {
  report: AnalysisReport;
  locale: Locale;
  t: Dictionary;
  /** How the previous period reads ("last month", "last week"). */
  previousLabel: string;
  /** Several currencies on the page: titles carry the code. */
  showCode: boolean;
}

const link = "text-primary underline-offset-4 hover:underline";

/** A source's name: the institution of a Plaid login, else the source's own name. */
export function sourceName(f: Pick<SourceFreshness, "source" | "label">, t: Dictionary): string {
  return f.label ?? t.analysis.sources.names[f.source];
}

/** A ledger source's name as Transactions shows it ("Alipay", "ICBC credit card"). */
function sourceLabel(source: string, t: Dictionary): string {
  return t.transactions.sources[source as keyof Dictionary["transactions"]["sources"]] ?? source;
}

/** One observation: a 16px grey icon and a sentence (with an optional link after it). */
export function InsightRow({ icon: Icon, children, testId }: { icon: LucideIcon; children: ReactNode; testId?: string }) {
  return (
    <li className="flex items-start gap-3 px-4 py-3 md:px-5" data-testid={testId}>
      <Icon aria-hidden className="mt-0.5 size-4 shrink-0 text-2" />
      <div className="min-w-0 flex-1 text-body">{children}</div>
    </li>
  );
}

/** "Partial: WeChat through Sep 24 · Import": the sources whose data ends before the period does. */
export function PartialLine({ keys, ctx }: { keys: string[]; ctx: InsightContext }) {
  const { t, locale, report } = ctx;
  const a = t.analysis;
  const parts = keys.map((k) => {
    const f = report.freshness.find((x) => x.key === k);
    if (!f) return k;
    return f.through
      ? fmt(a.partialSource, { source: sourceName(f, t), date: dayLabel(f.through, locale) })
      : fmt(a.partialNever, { source: sourceName(f, t) });
  });
  return (
    <span data-testid="partial-line">
      {fmt(a.partial, { sources: parts.join(t.common.listSep) })}
      <span className="text-3"> · </span>
      <Link href="/import" className={link}>
        {a.import}
      </Link>
    </span>
  );
}

/** "$12.40 more than last month" (totals), or the daily version while the period runs. */
function compareText(current: number, other: number, label: string, daily: boolean, currency: string, t: Dictionary): ReactNode {
  const c = t.stats.compare;
  const diff = current - other;
  if (diff === 0) return fmt(daily ? c.dailySame : c.same, { prev: label });
  const template = diff < 0 ? (daily ? c.dailyLess : c.less) : daily ? c.dailyMore : c.more;
  return rich(template, { prev: label, amount: <Money minor={Math.abs(diff)} currency={currency} /> });
}

const trendIcon = (diff: number): LucideIcon => (diff > 0 ? TrendingUpIcon : diff < 0 ? TrendingDownIcon : MinusIcon);

/** Transactions for one day, optionally searched. */
function dayHref(day: string, q?: string): string {
  const p = new URLSearchParams({ from: day, to: day });
  if (q) p.set("q", q);
  return `/transactions?${p.toString()}`;
}

/** The sentences for one currency: partial, comparisons, target, shifts, unusual rows, new merchants. */
export function currencyInsightRows(c: AnalysisCurrency, ctx: InsightContext, opts: { comparePrevious: boolean }): ReactNode[] {
  const { report, t, locale } = ctx;
  const a = t.analysis;
  const cur = c.currency;
  const rows: ReactNode[] = [];
  const partial = c.partialSources.length > 0;
  if (partial) {
    rows.push(
      <InsightRow key="partial" icon={HourglassIcon} testId="insight-partial">
        <PartialLine keys={c.partialSources} ctx={ctx} />
        <span className="block text-meta text-2">{a.partialHint}</span>
      </InsightRow>,
    );
  } else {
    const daily = report.inProgress;
    const value = daily ? c.dailyAverageMinor : c.spendingMinor;
    if (opts.comparePrevious && c.previous) {
      const other = daily ? c.previous.dailyAverageMinor : c.previous.spendingMinor;
      rows.push(
        <InsightRow key="prev" icon={trendIcon(value - other)} testId="insight-previous">
          {compareText(value, other, ctx.previousLabel, daily, cur, t)}
        </InsightRow>,
      );
    }
    if (c.typical && report.kind !== "range") {
      const other = daily || report.kind === "day" ? c.typical.dailyMinor : c.typical.perPeriodMinor;
      rows.push(
        <InsightRow key="typical" icon={trendIcon(value - other)} testId="insight-typical">
          {compareText(daily ? c.dailyAverageMinor : c.spendingMinor, other, fmt(a.typical[report.kind], { count: c.typical.periods }), daily && report.kind !== "day", cur, t)}
        </InsightRow>,
      );
    }
  }
  if (report.kind === "month" && c.target && c.target.remainingMinor < 0) {
    rows.push(
      <InsightRow key="target" icon={TargetIcon} testId="insight-target">
        {rich(a.overTarget, { amount: <Money minor={-c.target.remainingMinor} currency={cur} /> })}
      </InsightRow>,
    );
  }
  for (const s of partial ? [] : c.categoryShifts) {
    const q = new URLSearchParams({ from: report.from, to: report.to });
    if (s.categoryId == null) q.set("uncategorized", "1");
    else q.set("categoryId", String(s.categoryId));
    const name = s.categoryId == null ? t.common.uncategorized : categoryLabel(s.name, t);
    rows.push(
      <InsightRow key={`shift-${s.categoryId ?? "none"}`} icon={categoryIcon(s.categoryId == null ? null : s.name)} testId="insight-shift">
        <Link href={`/transactions?${q.toString()}`} className="hover:underline">
          {rich(s.deltaMinor > 0 ? a.shiftMore : a.shiftLess, { category: name, amount: <Money minor={Math.abs(s.deltaMinor)} currency={cur} /> })}
        </Link>
      </InsightRow>,
    );
  }
  for (const u of c.unusual) {
    const amount = <Money minor={u.minor} currency={cur} />;
    const text =
      u.kind === "larger_than_usual"
        ? rich(a.largerThanUsual, { merchant: u.merchant, amount, usual: <Money minor={u.usualMinor} currency={cur} /> })
        : u.kind === "first_large"
          ? rich(a.firstLarge, { merchant: u.merchant, amount })
          : rich(a.possibleDuplicate, {
              merchant: u.merchant,
              amount,
              source: sourceLabel(u.otherSource, t),
              other: sourceLabel(u.source, t),
              date: dayLabel(u.occurredOn, locale),
            });
    rows.push(
      <InsightRow key={`unusual-${u.id}`} icon={u.kind === "possible_duplicate" ? CopyIcon : AlertCircleIcon} testId="insight-unusual">
        <Link href={dayHref(u.occurredOn, u.merchant)} className="hover:underline">
          {text}
        </Link>
      </InsightRow>,
    );
  }
  if (c.newMerchants.length > 0) {
    const list = c.newMerchants.map((m, i) => (
      <span key={m.merchant}>
        {i > 0 && t.common.listSep}
        <Link href={`/transactions?${new URLSearchParams({ from: report.from, to: report.to, q: m.merchant }).toString()}`} className="hover:underline">
          {m.merchant}
        </Link>{" "}
        <span className="text-2">
          (<Money minor={m.minor} currency={cur} />)
        </span>
      </span>
    ));
    rows.push(
      <InsightRow key="new" icon={StoreIcon} testId="insight-new">
        {rich(plural(a.newMerchants, c.newMerchants.length), { list: <>{list}</> })}
      </InsightRow>,
    );
  }
  return rows;
}

/** The largest rows of the period (moved here from the neutral numbers). */
export function LargestCard({ c, ctx }: { c: AnalysisCurrency; ctx: InsightContext }) {
  const { t, locale, report } = ctx;
  const multiYear = report.from.slice(0, 4) !== report.to.slice(0, 4);
  const code = ctx.showCode && <span className="ml-2 text-meta font-normal text-3">{c.currency}</span>;
  return (
    <ListCard icon={ArrowDownWideNarrowIcon} title={<>{t.analysis.largest}{code}</>} data-testid="insights-largest">
      {c.largest.length === 0 ? (
        <p className="px-4 py-4 text-body text-2 md:px-5">{t.stats.noSpending}</p>
      ) : (
        <ol className="divide-y divide-line-soft">
          {c.largest.map((r) => (
            <li key={r.id}>
              <Link href={dayHref(r.occurredOn)} className="flex h-12 items-center gap-3 px-4 transition-colors duration-[120ms] hover:bg-sunken md:px-5">
                <span className={multiYear ? "w-24 shrink-0 text-meta text-2" : "w-16 shrink-0 text-meta text-2"}>{dayLabel(r.occurredOn, locale, { year: multiYear })}</span>
                <span className="min-w-0 flex-1 truncate">{r.merchant}</span>
                <Money minor={r.minor} currency={c.currency} />
              </Link>
            </li>
          ))}
        </ol>
      )}
    </ListCard>
  );
}

/** Holdings change per currency, deposits apart from what the market did. */
export function InvestmentsCard({ ctx }: { ctx: InsightContext }) {
  const { report, t } = ctx;
  const a = t.analysis;
  if (!report.investments) return null;
  return (
    <ListCard
      icon={WalletIcon}
      title={a.investments}
      data-testid="insights-investments"
      action={
        <Link href="/assets?view=investments" className={`shrink-0 text-meta ${link}`}>
          {a.investLink}
        </Link>
      }
    >
      <ul className="divide-y divide-line-soft">
        {report.investments.map((i) => (
          <li key={i.currency} className="flex flex-col gap-0.5 px-4 py-3 md:px-5">
            <span className="text-body">
              {i.startMinor != null && i.changeMinor != null
                ? rich(a.investChange, {
                    start: <Money minor={i.startMinor} currency={i.currency} />,
                    end: <Money minor={i.endMinor ?? 0} currency={i.currency} />,
                    change: <Money minor={i.changeMinor} currency={i.currency} sign="signed" />,
                  })
                : rich(a.investNoStart, { end: <Money minor={i.endMinor ?? 0} currency={i.currency} /> })}
            </span>
            <span className="flex flex-wrap gap-x-2 text-meta text-2">
              <span>{rich(a.investDeposits, { amount: <Money minor={i.netDepositsMinor} currency={i.currency} sign="signed" /> })}</span>
              {i.marketMinor != null && (
                <span>
                  · {rich(a.investMarket, { amount: <Money minor={i.marketMinor} currency={i.currency} sign="signed" /> })}
                </span>
              )}
              {i.dividendCount > 0 && <span>· {plural(a.investDividends, i.dividendCount)}</span>}
            </span>
            {i.partial && <span className="text-meta text-2">{a.investPartial}</span>}
          </li>
        ))}
      </ul>
    </ListCard>
  );
}

/** Failing or late sources, each linking to Settings > Connections. Nothing when all is well. */
export function AttentionCard({ ctx }: { ctx: InsightContext }) {
  const { report, t, locale } = ctx;
  const a = t.analysis;
  if (report.attention.length === 0) return null;
  return (
    <ListCard icon={AlertCircleIcon} title={a.attention} data-testid="insights-attention">
      <ul className="divide-y divide-line-soft">
        {report.attention.map((x) => (
          <InsightRow key={x.key} icon={x.kind === "plaid" ? WalletIcon : AlertCircleIcon}>
            {x.kind === "plaid"
              ? fmt(a.attentionPlaid, { name: x.label ?? a.sources.names.plaid })
              : x.state === "waiting"
                ? fmt(a.attentionIbkrWaiting, { date: dayLabel(x.expectedThrough ?? report.today, locale) })
                : a.attentionIbkrError}{" "}
            <Link href="/settings?tab=connections" className={link}>
              {a.connections}
            </Link>
          </InsightRow>
        ))}
      </ul>
    </ListCard>
  );
}

/**
 * Insights for a week, month or year: per currency the observations next to the largest rows, then investments and
 * anything that needs attention. Fixed periods only; a custom range shows the neutral numbers alone.
 */
export function PeriodInsights({ ctx }: { ctx: InsightContext }) {
  const { report, t } = ctx;
  const a = t.analysis;
  const extra = Object.keys(report.partial).filter((cur) => !report.currencies.some((c) => c.currency === cur));
  return (
    <section aria-label={a.insights} data-testid="insights" className="mb-12 flex flex-col gap-6">
      <h2 className="flex items-center gap-2 text-title font-semibold">
        <LightbulbIcon className="size-[18px] text-2" aria-hidden />
        {a.insights}
      </h2>
      {report.currencies.map((c) => {
        const rows = currencyInsightRows(c, ctx, { comparePrevious: true });
        return (
          <div key={c.currency} className="grid items-start gap-6 md:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]" data-testid={`insights-${c.currency}`}>
            <ListCard icon={ListIcon} title={fmt(a.insightsFor, { currency: c.currency })}>
              <ul className="divide-y divide-line-soft">
                {rows.length > 0 ? rows : <InsightRow icon={InboxIcon}>{<span className="text-2">{a.nothingStandsOut}</span>}</InsightRow>}
              </ul>
            </ListCard>
            <LargestCard c={c} ctx={ctx} />
          </div>
        );
      })}
      {extra.map((cur) => (
        <ListCard key={cur} icon={ListIcon} title={fmt(a.insightsFor, { currency: cur })} data-testid={`insights-${cur}`}>
          <ul>
            <InsightRow icon={HourglassIcon} testId="insight-partial">
              <PartialLine keys={report.partial[cur]!} ctx={ctx} />
            </InsightRow>
          </ul>
        </ListCard>
      ))}
      <InvestmentsCard ctx={ctx} />
      <AttentionCard ctx={ctx} />
    </section>
  );
}
