"use client";

import { CheckCircle2Icon, PlugZapIcon, TriangleAlertIcon } from "lucide-react";
import type { IbkrTestResult } from "@yomi/contracts";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { Sheet } from "@/components/split/ui";
import { Button } from "@/components/ui-kit/button";
import { Dialog, DialogClose } from "@/components/ui/dialog";
import { fmt, plural } from "@/i18n";
import { useLocale, useT } from "@/i18n/client";
import { errorText } from "@/i18n/errors";
import { apiFetch } from "@/lib/api";
import { dayLabel } from "@/lib/month";
import { missingSectionNotes, unknownSectionNames } from "./ibkr-sections";

export type IbkrTestState = { kind: "idle" } | { kind: "testing" } | { kind: "ok"; result: IbkrTestResult } | { kind: "error"; text: string };

/** The outcome of a Test connection (setup dialog and the row's own test): waiting, statement and sections, or the calm error. */
export function IbkrTestReport({ test }: { test: IbkrTestState }) {
  const t = useT();
  const locale = useLocale();
  return (
    <div role="status" className="flex flex-col gap-1 text-meta text-2" data-testid="ibkr-test-result">
      {test.kind === "testing" && <span>{t.secrets.testSlow}</span>}
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

/** After a successful test: all six sections there, each missing one with what yomi will lack, and the ones a one-day test cannot settle. */
function SectionsReport({ sections }: { sections: IbkrTestResult["sections"] }) {
  const t = useT();
  const locale = useLocale();
  const i = t.secrets.ibkr;
  const notes = missingSectionNotes(sections, t);
  const unknown = unknownSectionNames(sections, t);
  return (
    <div className="flex flex-col gap-1" data-testid="ibkr-test-sections">
      {notes && (
        <>
          <span className="inline-flex items-center gap-1.5 text-foreground">
            <TriangleAlertIcon className="size-3.5 text-2" aria-hidden />
            {i.sectionsMissing}
          </span>
          <ul className="flex list-disc flex-col gap-0.5 pl-5">
            {notes.map((n) => (
              <li key={n.id}>
                <span className="font-medium text-foreground">{n.name}</span>: {n.effect}
              </li>
            ))}
          </ul>
        </>
      )}
      {unknown.length > 0 && (
        <span data-testid="ibkr-test-unknown">{fmt(i.sectionsUnknown, { names: new Intl.ListFormat(locale, { type: "conjunction" }).format(unknown) })}</span>
      )}
      {!notes && <span>{unknown.length ? i.sectionsRest : i.sectionsAll}</span>}
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

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    void run();
  }, []);

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
