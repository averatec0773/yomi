import type { ImportPreview } from "@yomi/contracts";
import type { ReactNode } from "react";
import { formatMinor } from "@yomi/core/money";
import { occurredOnFor } from "@yomi/core/time";
import { CheckIcon } from "lucide-react";
import { Money } from "@/components/money";
import { fmt, plural } from "@/i18n";
import { accountLabel } from "@/i18n/accounts";
import { useT } from "@/i18n/client";
import { noticeText } from "@/i18n/errors";
import type { Dictionary } from "@/i18n/en";
import { rich } from "@/i18n/rich";
import { useTimeZone } from "@/lib/time-zone";
import { cn } from "@/lib/utils";
import { statementCurrency } from "./labels";

/** Money when the currency is known, else bare digits (never guess a symbol). */
function Amount({ minor, currency, className }: { minor: number; currency: string | null; className?: string }) {
  if (currency) return <Money minor={minor} currency={currency} className={className} />;
  return <span className={cn("num", className)}>{formatMinor(minor, "XXX").replace(/^-?XXX /, minor < 0 ? "−" : "")}</span>;
}

/** The statement period as days in the user's zone (Beijing-time statements converted, like their rows). */
function period(p: ImportPreview, t: Dictionary, timeZone: string): string | null {
  if (!p.periodStart && !p.periodEnd) return null;
  const day = (iso: string | null) => (iso ? occurredOnFor(iso, p.source, timeZone) : "?");
  return fmt(t.import.receipt.periodRange, { from: day(p.periodStart), to: day(p.periodEnd) });
}

/** Declared-vs-parsed receipt for one file, plus what the import will do. */
export function Receipt({ preview }: { preview: ImportPreview }) {
  const t = useT();
  const rt = t.import.receipt;
  const cur = statementCurrency(preview.source, preview.spending);
  const rec = preview.reconciliation;
  const buckets = rec.buckets.filter((b) => b.declared != null || b.parsed.count > 0);
  const per = period(preview, t, useTimeZone());
  // The already-imported notice is shown by the flow with its force option; drop core's duplicate notice.
  const warnings = preview.alreadyImported ? preview.warnings.filter((w) => w.code !== "import_file_seen") : preview.warnings;

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <div className="min-w-0">
          <div className="text-meta text-2">{t.import.sources[preview.source] ?? preview.source}</div>
          <div className="truncate text-title font-medium" title={preview.fileName}>
            {preview.fileName}
          </div>
        </div>
        {per && <div className="num text-meta text-2">{per}</div>}
      </div>

      <div className="max-w-md">
        <div className="mb-1 flex items-center justify-between text-meta text-2">
          <span>{rt.check}</span>
          {rec.ok ? (
            <span className="inline-flex items-center gap-1 text-pos">
              <CheckIcon className="size-3.5" aria-hidden />
              {rt.matches}
            </span>
          ) : (
            <span className="text-neg">{rt.mismatch}</span>
          )}
        </div>
        <dl className="border-t border-border">
          <ReceiptLine
            label={rt.rows}
            declared={rec.count.declared == null ? null : plural(rt.count, rec.count.declared)}
            parsed={plural(rt.count, rec.count.parsed)}
            ok={rec.count.ok}
            diff={rec.count.declared == null ? null : plural(rt.diffCount, Math.abs(rec.count.declared - rec.count.parsed))}
          />
          {buckets.map((b) => {
            const name = t.import.buckets[b.bucket];
            const d = b.declared;
            const diffCount = d ? Math.abs(d.count - b.parsed.count) : 0;
            const diffMinor = d ? Math.abs(d.minor - b.parsed.minor) : 0;
            return (
              <ReceiptLine
                key={b.bucket}
                label={name}
                declared={
                  d ? (
                    <>
                      {plural(rt.count, d.count)} <Amount minor={d.minor} currency={cur} className="ml-2 min-w-[5.5rem] sm:min-w-[6.5rem]" />
                    </>
                  ) : null
                }
                parsed={
                  <>
                    {plural(rt.count, b.parsed.count)} <Amount minor={b.parsed.minor} currency={cur} className="ml-2 min-w-[5.5rem] sm:min-w-[6.5rem]" />
                  </>
                }
                ok={b.ok}
                diff={
                  d ? <>{rich(plural(rt.diffBoth, diffCount), { amount: <Amount minor={diffMinor} currency={cur} /> })}</> : null
                }
              />
            );
          })}
        </dl>
      </div>

      <div className="flex flex-col gap-1.5 text-body">
        <p className="flex flex-wrap gap-x-3 gap-y-1 text-2">
          <span>{rich(rt.newCount, { n: <b className="num font-medium text-foreground">{preview.newCount}</b> })}</span>
          <span>{rich(rt.dupCount, { n: <b className="num font-medium text-foreground">{preview.dupCount}</b> })}</span>
          <span>{rich(rt.linkCount, { n: <b className="num font-medium text-foreground">{preview.linkCount}</b> })}</span>
          <span>{rich(rt.closedCount, { n: <b className="num font-medium text-foreground">{preview.closedCount}</b> })}</span>
        </p>
        {preview.spending.map((s) => (
          <p key={s.currency} className="text-2">
            {rich(plural(rt.newSpending, s.count), { amount: <Money minor={s.spendingMinor} currency={s.currency} className="text-foreground" /> })}
          </p>
        ))}
        {preview.autoSplit > 0 && (
          <p className="text-2">
            {rich(rt.autoSplit, { n: <b className="num font-medium text-foreground">{preview.autoSplit}</b> })}
          </p>
        )}
        {preview.accountsToCreate.length > 0 && (
          <p className="text-2">
            {rich(rt.newAccounts, { names: <span className="text-foreground">{preview.accountsToCreate.map((a) => accountLabel(a.name, t)).join(t.common.listSep)}</span> })}
          </p>
        )}
        {warnings.length > 0 && (
          <ul className="mt-1 flex flex-col gap-1 rounded-md bg-sunken px-3 py-2 text-meta text-2">
            {warnings.map((w, i) => (
              <li key={i} data-code={w.code}>
                {noticeText(w, t)}
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

function ReceiptLine({
  label,
  declared,
  parsed,
  ok,
  diff,
}: {
  label: string;
  declared: ReactNode | null;
  parsed: ReactNode;
  ok: boolean;
  diff: ReactNode | null;
}) {
  const rt = useT().import.receipt;
  return (
    <div className="border-b border-border py-2">
      <div className="grid grid-cols-[3.5rem_minmax(0,1fr)_1rem] sm:grid-cols-[4.5rem_minmax(0,1fr)_1.25rem] items-center gap-x-3 gap-y-0.5">
        <dt className="row-span-2 self-start text-2">{label}</dt>
        <dd className="contents">
          <span className="flex items-baseline justify-between gap-2 text-meta text-2">
            <span className="whitespace-nowrap">{rt.declared}</span>
            <span className="num whitespace-nowrap">{declared ?? <span className="text-3">{rt.notDeclared}</span>}</span>
          </span>
          <span />
          <span className="flex items-baseline justify-between gap-2">
            <span className="whitespace-nowrap text-meta text-2">{rt.parsed}</span>
            <span className="num whitespace-nowrap">{parsed}</span>
          </span>
          <span className="flex justify-end">
            {ok ? <CheckIcon className="size-4 text-pos" aria-label={rt.ok} /> : <span className="sr-only">{rt.notOk}</span>}
          </span>
        </dd>
      </div>
      {!ok && diff && <div className="mt-1 pl-[4.25rem] sm:pl-[5.25rem] text-meta text-neg">{diff}</div>}
    </div>
  );
}
