import { type Statement, type StatementEntry, StatementQuery } from "@yomi/contracts";
import { getCurrentUser, SplitError, statementText } from "@yomi/core";
import { formatMinor } from "@yomi/core/money";
import type { Metadata } from "next";
import { connection } from "next/server";
import type { ReactNode } from "react";
import { HowToPay } from "@/components/payment/how-to-pay";
import { BackToStatement, ImageButtons, PaperToggle, PinScreenTheme, PrintButton } from "@/components/split/print-button";
import {
  cssString,
  myShareLabel,
  othersIn,
  pageOfContent,
  scopeHeading,
  splitWaysLabel,
  statementImageName,
} from "@/components/split/statement-scope";
import { type Dictionary, fmt, getDictionary, toLocale } from "@/i18n";
import { categoryLabel } from "@/i18n/categories";
import { rich } from "@/i18n/rich";
import { getDb } from "@/lib/db";
import { dayLabel } from "@/lib/month";
import { getToday } from "@/lib/settings";
import { cn } from "@/lib/utils";

type Search = Record<string, string | string[] | undefined>;
type Shown = Pick<StatementEntry, "merchant" | "paidByThem" | "sharedNote" | "splitCount" | "sharedWith" | "category">;

/**
 * The item cell: merchant, then who shared, category and who paid after a middle dot, then the note on its own line.
 * Each part keeps together with its dot ("· Split 3 ways (with Li)" moves down whole) and breaks inside only when it
 * alone is wider than the column; a long line wraps between parts.
 */
function ItemCell({ it, s, t, quiet }: { it: Shown; s: Statement; t: Dictionary; quiet: boolean }) {
  const p = t.split.print;
  const on = (f: Statement["show"][number]) => s.show.includes(f);
  const meta = [
    splitWaysLabel(p, it, s.show),
    on("category") && it.category ? categoryLabel(it.category, t) : "",
    it.paidByThem ? fmt(p.theyPaidItem, { name: s.participantName }) : "",
  ].filter(Boolean);
  return (
    <>
      <span className={cn("text-body", quiet ? "text-2" : "text-foreground")}>{it.merchant || t.common.noName}</span>
      {meta.map((part) => (
        <span key={part} className="text-2">
          {" "}
          <span className="print-part">· {part}</span>
        </span>
      ))}
      {on("notes") && it.sharedNote && <span className="mt-0.5 block text-3">{fmt(p.note, { note: it.sharedNote })}</span>}
    </>
  );
}

/** An outlined status pill (13px), with a quiet second line for what is left on a partly settled item. */
function StatusPill({ children, sub, quiet }: { children: ReactNode; sub?: ReactNode; quiet?: boolean }) {
  return (
    <>
      <span className={cn("print-pill", quiet && "text-2")}>{children}</span>
      {sub && <span className="mt-0.5 block text-hint text-3">{sub}</span>}
    </>
  );
}

/**
 * A ListCard-like block on paper: bordered surface, 16/600 title, hairline rows. On paper a table section draws its
 * card with the table's own cells instead (see `PrintTable` and printCss), so each page fragment ends at its last row.
 */
function PrintSection({ title, testId, children }: { title: string; testId?: string; children: ReactNode }) {
  return (
    <section className="print-card mt-6 rounded-xl border border-border bg-surface" data-testid={testId}>
      <h2 className="print-card-title flex min-h-12 items-center border-b border-line-soft px-4 py-2.5 text-title font-semibold md:px-5">
        {title}
      </h2>
      {children}
    </section>
  );
}

/**
 * The rows of a table section kept apart for paper: the last three item rows go with the Total (and any rows after
 * the items) into one unbreakable group, so a page never starts with the header and the Total alone.
 */
function tailSplit<T>(rows: readonly T[], keep = 3): [T[], T[]] {
  const k = Math.max(0, rows.length - keep);
  return [rows.slice(0, k), rows.slice(k)];
}

/**
 * A section's table. On screen the section card frames it; on paper the section title repeats as the first header
 * row on every page, the cells draw the card's sides, and the repeated `tfoot` closes the card right after the last
 * row of each page (no empty strip down to the page end).
 */
function PrintTable({
  title,
  cols,
  colgroup,
  header,
  children,
  testId,
}: {
  title: string;
  cols: number;
  colgroup?: ReactNode;
  header: ReactNode;
  children: ReactNode;
  testId?: string;
}) {
  return (
    <table className="print-table w-full text-meta" data-testid={testId}>
      {colgroup}
      <thead>
        <tr className="print-head-title">
          <th colSpan={cols} scope="colgroup">
            {title}
          </th>
        </tr>
        {header}
      </thead>
      {children}
      <tfoot className="print-close" aria-hidden>
        <tr>
          <td colSpan={cols} />
        </tr>
      </tfoot>
    </table>
  );
}

function parse(sp: Search) {
  const flat = Object.fromEntries(Object.entries(sp).map(([k, v]) => [k, Array.isArray(v) ? v[0] : v]));
  const q = StatementQuery.safeParse(flat);
  return q.success ? q.data : null;
}

async function load(sp: Search) {
  const q = parse(sp);
  const locale = toLocale(q?.locale ?? (typeof sp.locale === "string" ? sp.locale : undefined));
  if (!q) return { locale, statement: null };
  try {
    return {
      locale,
      statement: await statementText(await getDb(), getCurrentUser(), q.participantId, q.currency, {
        locale,
        recentSince: q.recentSince,
        scope: q.scope,
        itemIds: q.items,
        show: q.show,
      }),
    };
  } catch (e) {
    if (e instanceof SplitError) return { locale, statement: null };
    throw e;
  }
}

export async function generateMetadata({ searchParams }: PageProps<"/split/statement/print">): Promise<Metadata> {
  await connection();
  const { locale, statement } = await load(await searchParams);
  const p = getDictionary(locale).split.print;
  return { title: statement ? fmt(p.metaTitle, { name: statement.participantName, currency: statement.currency }) : p.notFound };
}

/**
 * Print view of a statement (server-rendered, no app chrome), in the statement's own language (`locale`, not the
 * UI's). On screen: a paper preview on a neutral well with Save as PDF / Print (both open the print dialog) and Back
 * to statement. On paper: the same hierarchy as the on-screen statement (title, scope, hero balance, bordered
 * sections with a repeating table header, then "My payment details" when the user has payment methods for the currency), in
 * the app theme with backgrounds by default so the PDF matches the preview; `colors=light` ("Print on white paper")
 * forces the light paper.
 * Each page carries a footer (title, as-of date, "Page N of M") drawn in the @page margin boxes.
 */
export default async function StatementPrintPage({ searchParams }: PageProps<"/split/statement/print">) {
  await connection();
  const sp = await searchParams;
  const { locale, statement: s } = await load(sp);
  // The paper matches the screen (theme and backgrounds) unless "Print on white paper" asked for colors=light.
  const screenColors = sp.colors !== "light";
  const t = getDictionary(locale);
  const p = t.split.print;
  const st = t.split.statement;
  const m = (minor: number, currency = s?.currency ?? "USD") => formatMinor(minor, currency);
  const day = (d: string) => dayLabel(d, locale, { year: true });
  const isoToday = await getToday();
  const today = day(isoToday);
  const mine = s?.show.includes("myshare") ?? false;
  const settledDay = (d: string) => dayLabel(d, locale, { year: d.slice(0, 4) !== isoToday.slice(0, 4) });

  if (!s) {
    return (
      <div data-print-doc lang={locale} className="print-doc mx-auto w-full max-w-[960px]">
        <div data-print-toolbar className="mb-4 flex">
          <BackToStatement label={p.back} />
        </div>
        <p className="text-body text-2">{p.notFound}</p>
      </div>
    );
  }

  const title = fmt(p.title, { name: s.participantName });
  const subtitle = fmt(p.subtitle, { currency: s.currency, date: today });
  const others = s.show.includes("names") ? othersIn(s.scopeItems) : [];
  const listed = s.scope === "open" ? s.openItems : s.scopeItems;
  const openRows = listed.filter((it) => it.status !== "covered");
  const settledRows = listed.filter((it) => it.status === "covered");
  const withOpening = s.scope !== "selected" && s.openOpeningMinor !== 0;
  const withAhead = s.scope !== "selected" && s.unmatchedMinor !== 0;
  const showOpen = s.scope === "open" || openRows.length > 0 || withOpening || withAhead || settledRows.length === 0;
  const heroLabel =
    s.balanceMinor > 0 ? fmt(p.theyPay, { name: s.participantName }) : s.balanceMinor < 0 ? fmt(p.iPay, { name: s.participantName }) : p.even;

  const itemCols = mine ? 6 : 5;
  const colgroup = (
    <colgroup>
      <col className="print-col-date" />
      <col className="print-col-item" />
      <col className="print-col-total" />
      {mine && <col className={cn("print-col-mine", s.myName && "print-col-named")} />}
      <col className="print-col-share" />
      <col className="print-col-status" />
    </colgroup>
  );
  const header = (
    <tr>
      <th className="print-col-date">{p.date}</th>
      <th className="print-col-item">{p.item}</th>
      <th className="num print-col-total">{p.total}</th>
      {mine && (
        <th className={cn("num print-col-mine", s.myName && "print-col-named")} data-testid="print-my-share-head">
          {myShareLabel(p, s?.myName)}
        </th>
      )}
      <th className="num print-col-share">{p.share}</th>
      <th className="print-col-status">{p.status}</th>
    </tr>
  );
  const [openLead, openTail] = tailSplit(openRows);
  const [settledLead, settledTail] = tailSplit(settledRows);
  const itemRow = (it: StatementEntry) => {
    const covered = it.status === "covered";
    return (
      <tr key={it.transactionId} className="print-item">
        <td className="print-col-date text-2">{day(it.date)}</td>
        <td className="print-col-item">
          <ItemCell it={it} s={s} t={t} quiet={covered} />
        </td>
        <td className="num print-col-total text-2">{m(it.totalMinor)}</td>
        {mine && <td className="num print-col-mine text-2">{m(it.myShareMinor)}</td>}
        <td className={cn("num print-col-share text-body font-medium", covered && "text-2")}>{m(it.theirShareMinor)}</td>
        <td className="print-col-status">
          {covered ? (
            <StatusPill quiet>{it.settledOn ? fmt(p.settledOn, { date: settledDay(it.settledOn) }) : p.covered}</StatusPill>
          ) : it.status === "partial" ? (
            <StatusPill sub={fmt(st.left, { amount: m(Math.abs(it.remainingMinor)) })}>{st.status.partial}</StatusPill>
          ) : (
            <StatusPill>{p.open}</StatusPill>
          )}
        </td>
      </tr>
    );
  };
  const extraRow = (label: string, minor: number, open: boolean) => (
    <tr>
      <td className="print-col-date" />
      <td className="print-col-item text-2">{label}</td>
      <td className="print-col-total" />
      {mine && <td className="print-col-mine" />}
      <td className="num print-col-share text-body font-medium">{m(minor)}</td>
      <td className="print-col-status">{open && <StatusPill>{p.open}</StatusPill>}</td>
    </tr>
  );
  const totalRow = (rows: StatementEntry[]) => (
    <tr className="print-total font-medium">
      <td className="print-col-date" />
      <td className="print-col-item">{p.sectionTotal}</td>
      <td className="num print-col-total">{m(rows.reduce((sum, it) => sum + it.totalMinor, 0))}</td>
      {mine && <td className="num print-col-mine">{m(rows.reduce((sum, it) => sum + it.myShareMinor, 0))}</td>}
      <td className="num print-col-share text-body">{m(rows.reduce((sum, it) => sum + it.theirShareMinor, 0))}</td>
      <td className="print-col-status" />
    </tr>
  );
  const scopeTotalRow = (
    <tr className="print-total font-medium" data-testid="print-scope-total">
      <td className="print-col-date" />
      <td className="print-col-item">{p.scopeTotal}</td>
      <td className="print-col-total" />
      {mine && <td className="print-col-mine" />}
      <td className="num print-col-share text-body">{m(s.scopeRemainingMinor)}</td>
      <td className="print-col-status" />
    </tr>
  );

  return (
    <div data-print-doc data-print-colors={screenColors ? "screen" : "light"} lang={locale} className="print-doc mx-auto w-full max-w-[960px]">
      <style>{printCss({ footer: `${title} · ${subtitle}`, pageOf: p.pageOf, screenColors })}</style>
      {screenColors && <PinScreenTheme />}
      <div data-print-toolbar className="mb-4 flex flex-col gap-2">
        <div className="flex flex-wrap items-center gap-2" role="toolbar" aria-label={p.toolbar}>
          <BackToStatement label={p.back} />
          <span className="flex-1" />
          <PaperToggle participantId={s.participantId} whitePaper={!screenColors} label={st.optWhitePaper} />
          <div className="flex flex-wrap items-center gap-2 max-sm:grid max-sm:w-full max-sm:grid-cols-2">
            <ImageButtons
              fileName={statementImageName(s.participantName, s.participantId, s.currency, isoToday)}
              labels={{
                save: p.saveImage,
                copy: p.copyImage,
                working: p.imageWorking,
                saved: p.imageSaved,
                copied: p.imageCopied,
                failed: t.errors.codes.image_export_failed ?? t.errors.unknown,
                copyFailed: t.errors.codes.image_copy_failed ?? t.errors.unknown,
              }}
            />
            <PrintButton kind="print" label={p.printNow} />
            <PrintButton kind="pdf" label={p.savePdf} />
          </div>
        </div>
        <p className="text-meta text-2 sm:text-right">{p.savePdfHint}</p>
      </div>

      <article
        data-print-paper
        className={cn("print-paper rounded-xl border border-border bg-surface px-4 py-6 text-foreground sm:px-10 sm:py-10", !screenColors && "light")}
      >
        <header className="flex flex-col gap-5 border-b border-border pb-6 sm:flex-row sm:items-start sm:justify-between">
          <div className="min-w-0">
            <h1 className="text-page font-semibold">{title}</h1>
            <p className="mt-1.5 text-meta text-2">{subtitle}</p>
            <p className="mt-0.5 text-meta font-medium" data-testid="print-scope">
              {scopeHeading(p, s.scope, s.scopeItems.length)}
            </p>
            {others.length > 0 && (
              <p className="mt-0.5 text-meta text-2" data-testid="print-shared-with">
                {fmt(p.alsoShared, { names: others.join(p.nameSeparator) })}
              </p>
            )}
          </div>
          <div className="print-hero shrink-0 rounded-xl border border-border bg-tile px-5 py-4 sm:min-w-56 sm:text-right" data-testid="print-hero">
            <p className="text-meta text-2">{heroLabel}</p>
            <p
              className={cn("font-num text-hero font-semibold tracking-[-0.02em] whitespace-nowrap tabular-nums", s.balanceMinor < 0 && "text-neg")}
              data-testid="print-balance"
            >
              {m(Math.abs(s.balanceMinor))}
            </p>
          </div>
        </header>

        {showOpen && (
          <PrintSection title={p.openTitle}>
            {openRows.length === 0 && !withOpening && !withAhead ? (
              <p className="px-4 py-4 text-body text-2 md:px-5">{p.nothingOpen}</p>
            ) : (
              <PrintTable title={p.openTitle} cols={itemCols} colgroup={colgroup} header={header}>
                {openLead.length > 0 && <tbody className="print-lead">{openLead.map(itemRow)}</tbody>}
                <tbody className="print-tail">
                  {openTail.map(itemRow)}
                  {withOpening && extraRow(p.opening, s.openOpeningMinor, true)}
                  {withAhead && extraRow(p.paidAhead, s.unmatchedMinor, false)}
                  {openRows.length > 0 && totalRow(openRows)}
                  {s.scope !== "open" && scopeTotalRow}
                </tbody>
              </PrintTable>
            )}
          </PrintSection>
        )}

        {settledRows.length > 0 && (
          <PrintSection title={p.settledTitle}>
            <PrintTable title={p.settledTitle} cols={itemCols} colgroup={colgroup} header={header}>
              {settledLead.length > 0 && <tbody className="print-lead">{settledLead.map(itemRow)}</tbody>}
              <tbody className="print-tail">
                {settledTail.map(itemRow)}
                {totalRow(settledRows)}
                {!showOpen && scopeTotalRow}
              </tbody>
            </PrintTable>
          </PrintSection>
        )}

        {s.scope !== "selected" && s.show.includes("settlements") && (
          <PrintSection title={fmt(p.recentTitle, { date: day(s.recentSince) })}>
            {s.recentSettlements.length === 0 ? (
              <p className="px-4 py-4 text-body text-2 md:px-5">{p.noRecent}</p>
            ) : (
              <PrintTable
                title={fmt(p.recentTitle, { date: day(s.recentSince) })}
                cols={3}
                header={
                  <tr>
                    <th className="print-col-date">{p.date}</th>
                    <th className="print-col-item">{p.item}</th>
                    <th className="num print-col-share">{p.paid}</th>
                  </tr>
                }
              >
                {s.recentSettlements.map((r) => (
                  <tbody key={r.settlementId} className="print-group">
                    <tr>
                      <td className="print-col-date text-2">{day(r.date)}</td>
                      <td className="print-col-item">
                        <span className="text-body">{fmt(r.amountMinor > 0 ? p.toMe : p.toThem, { name: s.participantName })}</span>
                        {r.originalAmountMinor !== null && r.originalCurrency && r.fxRate && (
                          <span className="block text-2">
                            {fmt(p.actually, { amount: m(Math.abs(r.originalAmountMinor), r.originalCurrency), rate: r.fxRate })}
                          </span>
                        )}
                        {r.note && <span className="block text-3">{r.note}</span>}
                      </td>
                      <td className="num print-col-share text-body font-medium">{m(Math.abs(r.amountMinor))}</td>
                    </tr>
                    {r.items.map((it) => (
                      <tr key={it.transactionId} className="print-sub">
                        <td className="print-col-date text-2">{day(it.date)}</td>
                        <td className="print-col-item text-2">
                          {it.merchant || t.common.noName}
                          {s.show.includes("notes") && it.sharedNote && <span className="block text-3">{fmt(p.note, { note: it.sharedNote })}</span>}
                        </td>
                        <td className="num print-col-share text-2">{m(it.paidMinor)}</td>
                      </tr>
                    ))}
                  </tbody>
                ))}
              </PrintTable>
            )}
          </PrintSection>
        )}

        <HowToPay methods={s.payment} t={t} currency={s.currency} variant="paper" />

        <p className="print-generated mt-8 text-hint text-3" data-testid="print-generated">
          {rich(p.generated, { brand: <span className="font-medium">yomi</span>, date: today })}
        </p>
      </article>
    </div>
  );
}

/**
 * The route's print CSS. Paper sizes follow the dialog (`size: auto`); the footer lives in the @page margin boxes
 * (Chromium 131+): title and as-of date on the left, "Page N of M" on the right.
 */
function printCss({ footer, pageOf, screenColors }: { footer: string; pageOf: string; screenColors: boolean }): string {
  // The page margins are painted by @page, not by <html> (Chromium falls back to its own canvas color, #121212 when
  // the system is dark), so they get the paper color: the theme surface and text-3 (`var()` resolves against the root
  // element in the page context), or white for the white paper.
  const screenPage = screenColors
    ? "@page { background: var(--surface); @bottom-left { color: var(--ink-3); } @bottom-right { color: var(--ink-3); } }"
    : "";
  return `
.print-doc { line-height: 1.5; }
.print-doc:lang(zh-CN) { line-height: 1.6; }
.print-table { border-collapse: collapse; table-layout: fixed; }
.print-table th { text-align: left; font-weight: 500; color: var(--ink-2); padding: 10px 12px 8px 0; border-bottom: 1px solid var(--line); white-space: nowrap; }
.print-table td { vertical-align: top; padding: 10px 12px 10px 0; border-bottom: 1px solid var(--tile); overflow-wrap: anywhere; }
.print-table tbody:last-of-type > tr:last-child > td { border-bottom: 0; }
/* Paper only: the section title as the first header row, and the card's closing edge (see @media print). */
.print-table .print-head-title, .print-table .print-close { display: none; }
.print-table th:first-child, .print-table td:first-child { padding-left: 16px; }
.print-table th:last-child, .print-table td:last-child { padding-right: 16px; }
@media (min-width: 768px) {
  .print-table th:first-child, .print-table td:first-child { padding-left: 20px; }
  .print-table th:last-child, .print-table td:last-child { padding-right: 20px; }
}
.print-table .num { text-align: right; white-space: nowrap; }
.print-table td.num.text-body { line-height: 22px; }
/* Fixed columns (Date, Total, My share, Their share, Status) and a flexible Item, the same in every section. */
.print-table .print-col-date { width: 120px; white-space: nowrap; }
.print-table .print-col-item { width: auto; }
/* A part wraps inside only when it is wider than the whole Item column (narrow paper); otherwise it moves down whole. */
.print-table .print-part { display: inline-block; max-width: 100%; white-space: normal; vertical-align: top; }
.print-table .print-col-total { width: 96px; }
.print-table .print-col-mine { width: 108px; }
/* "Alexandra Whitfield's share": a name of about 20 characters fits on two lines. */
.print-table .print-col-mine.print-col-named { width: 140px; }
.print-table .print-col-share { width: 108px; }
.print-table .print-col-status { width: 164px; white-space: nowrap; text-align: right; }
.print-table th.print-col-mine { white-space: normal; overflow-wrap: anywhere; }
.print-table .print-total td { border-top: 1px solid var(--line); }
.print-table .print-sub td { padding-top: 4px; padding-bottom: 6px; }
.print-table .print-sub td:first-child { padding-left: 32px; }
.print-group tr:not(:last-child) td { border-bottom: 0; }
.print-group { border-bottom: 1px solid var(--tile); }
.print-pill { display: inline-flex; align-items: center; height: 22px; padding: 0 8px; border: 1px solid var(--line-strong); border-radius: 999px; font-size: 13px; line-height: 20px; white-space: nowrap; }
.print-table thead { display: table-header-group; }
.print-table tr, .print-group, .print-hero, .print-pay, .print-pay-item { break-inside: avoid; }
.print-card { overflow: clip; box-decoration-break: clone; -webkit-box-decoration-break: clone; }
.print-card-title { break-after: avoid; }
.print-table td { line-height: 22px; }
.print-table td .block { line-height: 19px; }
/* Phones (screen only): each row stacks as item + amount over date + status; Total and My share stay on paper. */
@media screen and (max-width: 639px) {
  .print-table thead { display: none; }
  .print-table, .print-table tbody { display: block; }
  .print-table tr { display: grid; grid-template-columns: minmax(0, 1fr) auto; grid-template-areas: "item share" "date status"; column-gap: 12px; row-gap: 2px; padding: 10px 16px; border-bottom: 1px solid var(--tile); }
  .print-table tbody:last-of-type > tr:last-child { border-bottom: 0; }
  .print-group tr { border-bottom: 0; }
  .print-table td { display: block; padding: 0 !important; border: 0 !important; width: auto !important; }
  .print-table td:empty { display: none; }
  .print-table .print-col-item { grid-area: item; }
  .print-table .print-col-share { grid-area: share; }
  .print-table .print-col-date { grid-area: date; }
  .print-table .print-col-status { grid-area: status; justify-self: end; }
  .print-table .print-col-total, .print-table .print-col-mine { display: none; }
  .print-table .print-total { border-top: 1px solid var(--line); }
  .print-table colgroup { display: none; }
}
@page {
  size: auto;
  /* With the document's own 3mm (print media below) the frame sits 12mm / 8mm / 16mm from the edges; with the dialog's
     "Margins: None" it still keeps 3mm, and its own padding keeps the content off the frame. */
  margin: 9mm 5mm 13mm;
  background: #fff;
  @bottom-left { content: ${cssString(footer)}; font: 400 9pt -apple-system, "PingFang SC", "Noto Sans SC", system-ui, sans-serif; color: #6e6d66; vertical-align: top; padding-top: 3mm; }
  @bottom-right { content: ${pageOfContent(pageOf)}; font: 400 9pt -apple-system, "PingFang SC", "Noto Sans SC", system-ui, sans-serif; color: #6e6d66; vertical-align: top; padding-top: 3mm; white-space: nowrap; }
}
${screenPage}
@media print {
  .print-doc { max-width: none; padding: 3mm; box-decoration-break: clone; -webkit-box-decoration-break: clone; }
  /* The preview's card on paper: 1px border, 12px corners and padding, repeated on every page (clone). */
  .print-paper { padding: 24px 20px; box-decoration-break: clone; -webkit-box-decoration-break: clone; }
  .print-card-title { padding-left: 20px; padding-right: 20px; }
  .print-table th:first-child, .print-table td:first-child { padding-left: 20px; }
  .print-table th:last-child, .print-table td:last-child { padding-right: 20px; }
  .print-table .print-sub td:first-child { padding-left: 36px; }
  /* Letter and A4 leave about 650 to 700 px inside the frame: narrower fixed columns, Item shrinks first. */
  .print-table .print-col-date { width: 116px; }
  .print-table .print-col-total { width: 80px; }
  .print-table .print-col-mine { width: 92px; }
  .print-table .print-col-mine.print-col-named { width: 120px; }
  .print-table .print-col-share { width: 92px; }
  .print-table .print-col-status { width: 148px; }
  /*
   * A table section's card is drawn by the table itself, so each page fragment ends at its last row: a bordered box
   * around a table would stretch to the page end whenever the next row moves on (css-break), leaving an empty strip.
   * The section title repeats as the first header row, the first and last cells draw the sides, and the repeated
   * tfoot closes the card with its rounded corners right after the last row of every page (its shadow, in the paper
   * color and clipped to below its top, hides the side lines outside the curve).
   */
  .print-card:has(> .print-table) { border: 0; border-radius: 0; background: none; overflow: visible; box-decoration-break: slice; -webkit-box-decoration-break: slice; }
  .print-card:has(> .print-table) > .print-card-title { display: none; }
  .print-table { border-collapse: separate; border-spacing: 0; }
  .print-table .print-head-title { display: table-row; }
  .print-table .print-head-title th { padding: 12px 20px; border: 1px solid var(--line); border-bottom-color: var(--tile); border-radius: 12px 12px 0 0; font-size: 16px; line-height: 24px; font-weight: 600; color: inherit; white-space: normal; }
  .print-table tr > :first-child { border-left: 1px solid var(--line); }
  .print-table tr > :last-child { border-right: 1px solid var(--line); }
  .print-table .print-close { display: table-footer-group; }
  .print-table .print-close td { height: 0; padding: 0 !important; border: 0 !important; position: relative; }
  .print-table .print-close td::after { content: ""; position: absolute; left: 0; right: 0; top: -12px; height: 12px; box-sizing: border-box; border: 1px solid var(--line); border-top: 0; border-radius: 0 0 12px 12px; box-shadow: 0 0 0 13px var(--surface); clip-path: inset(0 -14px -14px -14px); }
  /* One line above a Total: the row before it takes the Total's rule (separate borders would draw both). */
  .print-table tr:has(+ .print-total) > td { border-bottom-color: var(--line); }
  .print-table .print-total td { border-top: 0; }
  /* Natural breaks: the header never ends a page, the last three items travel with the Total, the closing edge never
     moves on alone, and the payment details stay whole with the generated line after them: they follow the last
     section when they fit, else move to the next page together. */
  .print-table thead { break-inside: avoid; }
  .print-table thead + tbody, .print-table thead + tbody > tr:first-child { break-before: avoid; }
  .print-table .print-tail { break-inside: avoid; }
  .print-table tbody:last-of-type, .print-table tbody:last-of-type > tr:last-child { break-after: avoid; }
  .print-table .print-close { break-before: avoid; }
  .print-generated { break-before: avoid; }
}
`;
}
