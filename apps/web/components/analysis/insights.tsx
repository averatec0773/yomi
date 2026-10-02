import type { AnalysisCurrency, AnalysisReport, SourceFreshness } from "@yomi/core";
import { AlertCircleIcon, CopyIcon, HourglassIcon, type LucideIcon, StoreIcon, WalletIcon } from "lucide-react";
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
import { InsightList } from "./insight-list";

/** Everything a block needs to write its sentences. */
export interface InsightContext {
  report: AnalysisReport;
  locale: Locale;
  t: Dictionary;
}

/** One observation: an icon, a sentence, an optional quiet second line (the Day view shows it). */
export interface Insight {
  key: string;
  icon: LucideIcon;
  testId: string;
  content: ReactNode;
  hint?: ReactNode;
}

const link = "text-primary underline-offset-4 hover:underline";
/** An insight that opens its rows: a colour change on hover, no underline (it would break around the amounts). */
const rowLink = "transition-colors duration-[120ms] hover:text-primary";

/** A source's name: the institution of a Plaid login, else the source's own name. */
export function sourceName(f: Pick<SourceFreshness, "source" | "label">, t: Dictionary): string {
  return f.label ?? t.analysis.sources.names[f.source];
}

/** A ledger source's name as Transactions shows it ("Alipay", "ICBC credit card"). */
export function sourceLabel(source: string, t: Dictionary): string {
  return t.transactions.sources[source as keyof Dictionary["transactions"]["sources"]] ?? source;
}

/** One observation in a card list: a 16px grey icon and a sentence (with an optional link after it). */
export function InsightRow({ icon: Icon, children, testId }: { icon: LucideIcon; children: ReactNode; testId?: string }) {
  return (
    <li className="flex items-start gap-3 px-4 py-3 md:px-5" data-testid={testId}>
      <Icon aria-hidden className="mt-0.5 size-4 shrink-0 text-2" />
      <div className="min-w-0 flex-1 text-body">{children}</div>
    </li>
  );
}

/** "Partial: WeChat through Sep 24 · Import": the sources whose data ends before the period does. */
function PartialLine({ keys, ctx }: { keys: string[]; ctx: InsightContext }) {
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

/** Currencies with no rows in the period whose data is still partial: one quiet line each. */
export function PartialCurrencies({ ctx, className }: { ctx: InsightContext; className?: string }) {
  const { report } = ctx;
  const extra = Object.keys(report.partial).filter((cur) => !report.currencies.some((c) => c.currency === cur));
  if (extra.length === 0) return null;
  return (
    <div className={className}>
      {extra.map((cur) => (
        <p key={cur} className="flex items-start gap-2 text-meta text-2" data-testid="insight-partial">
          <HourglassIcon aria-hidden className="mt-0.5 size-3.5 shrink-0" />
          <span>
            {cur}: <PartialLine keys={report.partial[cur]!} ctx={ctx} />
          </span>
        </p>
      ))}
    </div>
  );
}

/** Transactions for one day, optionally searched. */
function dayHref(day: string, q?: string): string {
  const p = new URLSearchParams({ from: day, to: day });
  if (q) p.set("q", q);
  return `/transactions?${p.toString()}`;
}

/**
 * The observations for one currency, most important first: partial data, unusual rows, new merchants, category
 * shifts. A custom range gets the partial line only.
 */
export function currencyInsights(c: AnalysisCurrency, ctx: InsightContext): Insight[] {
  const { report, t, locale } = ctx;
  const a = t.analysis;
  const cur = c.currency;
  const out: Insight[] = [];
  const partial = c.partialSources.length > 0;
  if (partial) {
    out.push({ key: "partial", icon: HourglassIcon, testId: "insight-partial", content: <PartialLine keys={c.partialSources} ctx={ctx} />, hint: a.partialHint });
  }
  if (report.kind === "range") return out;
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
    out.push({
      key: `unusual-${u.id}`,
      icon: u.kind === "possible_duplicate" ? CopyIcon : AlertCircleIcon,
      testId: "insight-unusual",
      content: (
        <Link href={dayHref(u.occurredOn, u.merchant)} className={rowLink}>
          {text}
        </Link>
      ),
    });
  }
  if (c.newMerchants.length > 0) {
    const list = c.newMerchants.map((m, i) => (
      <span key={m.merchant}>
        {i > 0 && t.common.listSep}
        <Link href={`/transactions?${new URLSearchParams({ from: report.from, to: report.to, q: m.merchant }).toString()}`} className={rowLink}>
          {m.merchant}
        </Link>{" "}
        <span className="text-2">
          (<Money minor={m.minor} currency={cur} />)
        </span>
      </span>
    ));
    out.push({ key: "new", icon: StoreIcon, testId: "insight-new", content: rich(plural(a.newMerchants, c.newMerchants.length), { list: <>{list}</> }) });
  }
  for (const s of partial ? [] : c.categoryShifts) {
    const q = new URLSearchParams({ from: report.from, to: report.to });
    if (s.categoryId == null) q.set("uncategorized", "1");
    else q.set("categoryId", String(s.categoryId));
    const name = s.categoryId == null ? t.common.uncategorized : categoryLabel(s.name, t);
    out.push({
      key: `shift-${s.categoryId ?? "none"}`,
      icon: categoryIcon(s.categoryId == null ? null : s.name),
      testId: "insight-shift",
      content: (
        <Link href={`/transactions?${q.toString()}`} className={rowLink}>
          {rich(s.deltaMinor > 0 ? a.shiftMore : a.shiftLess, { category: name, amount: <Money minor={Math.abs(s.deltaMinor)} currency={cur} /> })}
        </Link>
      ),
    });
  }
  return out;
}

/** Insights inside a currency's summary card, under a thin divider; nothing when there are none. */
export function CurrencyInsights({ c, ctx }: { c: AnalysisCurrency; ctx: InsightContext }) {
  const items = currencyInsights(c, ctx);
  if (items.length === 0) return null;
  return (
    <InsightList
      label={fmt(ctx.t.analysis.insightsFor, { currency: c.currency })}
      testId={`insights-${c.currency}`}
      items={items.map(({ key, icon: Icon, testId, content }) => (
        <li key={key} className="flex items-start gap-2" data-testid={testId}>
          <Icon aria-hidden className="mt-[3px] size-4 shrink-0 text-2" />
          <span className="min-w-0">{content}</span>
        </li>
      ))}
    />
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
