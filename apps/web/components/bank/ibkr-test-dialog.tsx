"use client";

import { CheckCircle2Icon, CheckIcon, CircleDashedIcon, ListChecksIcon, PlugZapIcon, XIcon } from "lucide-react";
import type { IbkrSectionItem, IbkrTestResult } from "@yomi/contracts";
import { useRouter } from "next/navigation";
import { useEffect, useEffectEvent, useRef, useState } from "react";
import { Sheet } from "@/components/split/ui";
import { Button } from "@/components/ui-kit/button";
import { Dialog, DialogClose } from "@/components/ui/dialog";
import { fmt, plural } from "@/i18n";
import { useLocale, useT } from "@/i18n/client";
import { errorText } from "@/i18n/errors";
import { apiFetch } from "@/lib/api";
import { dayLabel } from "@/lib/month";
import { cn } from "@/lib/utils";
import { sectionStatusRows, sectionsSummary, unknownSectionNames } from "./ibkr-sections";

export type IbkrTestState = { kind: "idle" } | { kind: "testing" } | { kind: "ok"; result: IbkrTestResult } | { kind: "error"; text: string };

/** Seconds since this mounted (a test running), ticking once a second. */
function Elapsed() {
  const t = useT();
  const [seconds, setSeconds] = useState(0);
  useEffect(() => {
    const start = Date.now();
    const timer = setInterval(() => setSeconds(Math.floor((Date.now() - start) / 1000)), 1000);
    return () => clearInterval(timer);
  }, []);
  return (
    // Hidden from screen readers: inside the status region every tick would be announced.
    <span className="tabular-nums text-foreground" aria-hidden data-testid="ibkr-test-elapsed">
      {fmt(t.secrets.testElapsed, { seconds })}
    </span>
  );
}

/** The outcome of a Test connection (setup dialog and the row's own test): waiting, statement and sections, or the calm error. */
export function IbkrTestReport({ test }: { test: IbkrTestState }) {
  const t = useT();
  const locale = useLocale();
  return (
    <div role="status" className="flex flex-col gap-1 text-meta text-2" data-testid="ibkr-test-result">
      {test.kind === "testing" && (
        <>
          <Elapsed />
          <span>{t.secrets.testSlow}</span>
        </>
      )}
      {test.kind === "ok" && (
        <>
          <span className="inline-flex items-center gap-1.5 text-foreground">
            <CheckCircle2Icon className="size-3.5 text-2" aria-hidden />
            {plural(t.secrets.ibkr.testOk, test.result.positions, { date: dayLabel(test.result.statementDate, locale, { year: true }) })}
          </span>
          <SectionsReport sections={test.result.sections} />
        </>
      )}
      {test.kind === "error" && <span className="text-foreground">{test.text}</span>}
    </div>
  );
}

const STATE_ICON = { present: CheckIcon, missing: XIcon, unknown: CircleDashedIcon } as const;

/**
 * The six Flex sections yomi reads, each with its state (In the query, Missing, Not checked yet) and, with
 * `effects`, what yomi lacks without a missing one. Neutral icons: shape tells the states apart, never color.
 */
export function IbkrSectionList({ sections, effects = true }: { sections: IbkrSectionItem[]; effects?: boolean }) {
  const t = useT();
  return (
    <ul className="flex flex-col gap-1 text-meta text-2" data-testid="ibkr-section-list">
      {sectionStatusRows(sections, t).map((r) => {
        const Icon = STATE_ICON[r.state];
        return (
          <li key={r.id} className="flex items-start gap-1.5" data-section={r.id} data-state={r.state}>
            <Icon className="mt-[3px] size-3.5 shrink-0 text-2" aria-hidden />
            <span className="min-w-0">
              <span className="text-foreground">{r.name}</span>
              <span className="text-3"> · </span>
              <span className={cn(r.state === "missing" && "font-medium text-foreground")}>{r.label}</span>
              {effects && r.effect && <span className="block">{r.effect}</span>}
            </span>
          </li>
        );
      })}
    </ul>
  );
}

/** After a successful test: the six sections with their state, how to add missing ones, and why some are not checked yet. */
function SectionsReport({ sections }: { sections: IbkrTestResult["sections"] }) {
  const t = useT();
  const locale = useLocale();
  const i = t.secrets.ibkr;
  const missing = sections.filter((s) => s.state === "missing").length;
  const unknown = unknownSectionNames(sections, t);
  return (
    <div className="mt-1 flex flex-col gap-1.5" data-testid="ibkr-test-sections">
      <span className="inline-flex items-center gap-1.5 font-medium text-foreground" data-testid="ibkr-test-sections-summary">
        <ListChecksIcon className="size-3.5 text-2" aria-hidden />
        {sectionsSummary(sections, t)}
      </span>
      <IbkrSectionList sections={sections} />
      {missing > 0 && <span>{plural(t.connections.ibkr.sectionsFix, missing)}</span>}
      {unknown.length > 0 && (
        <span data-testid="ibkr-test-unknown">{fmt(i.sectionsUnknown, { names: new Intl.ListFormat(locale, { type: "conjunction" }).format(unknown) })}</span>
      )}
    </div>
  );
}

/**
 * Settings > Connections > Interactive Brokers > "Test connection" (sm dialog): tests the token and query ID yomi
 * uses now (env or Settings) without the replace form. It starts on open (POST /api/settings/secrets/ibkr/test with
 * no fields), shows the statement date, positions and the section check (which also lands on the row), and can run
 * again. Nothing but the section check is stored.
 */
export function IbkrTestDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {open && <IbkrTestSheet />}
    </Dialog>
  );
}

function IbkrTestSheet() {
  const t = useT();
  const router = useRouter();
  const i = t.connections.ibkr;
  const [test, setTest] = useState<IbkrTestState>({ kind: "testing" });
  // One request per opening, also under Strict Mode's double effect (IBKR rate-limits Flex requests).
  const started = useRef(false);

  async function run() {
    setTest({ kind: "testing" });
    try {
      setTest({ kind: "ok", result: await apiFetch<IbkrTestResult>("/api/settings/secrets/ibkr/test", { json: {}, silent: true }) });
    } catch (e) {
      setTest({ kind: "error", text: errorText(e, t) });
    } finally {
      router.refresh();
    }
  }

  const start = useEffectEvent(() => {
    if (started.current) return;
    started.current = true;
    void run();
  });
  useEffect(() => start(), []);

  const footer = (
    <div className="flex flex-wrap items-center justify-end gap-2">
      <DialogClose asChild>
        <Button variant="ghost">{t.common.close}</Button>
      </DialogClose>
      <Button onClick={() => void run()} disabled={test.kind === "testing"} data-testid="ibkr-test-again">
        <PlugZapIcon aria-hidden />
        {test.kind === "testing" ? t.secrets.testing : i.testAgain}
      </Button>
    </div>
  );

  return (
    <Sheet size="sm" title={i.testTitle} description={i.testDescription} footer={footer} data-testid="ibkr-test-dialog">
      <div className="pb-5">
        <IbkrTestReport test={test} />
      </div>
    </Sheet>
  );
}
