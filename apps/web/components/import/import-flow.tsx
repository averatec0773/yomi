"use client";

import type { ImportPreview, ImportResult, RevertResult } from "@yomi/contracts";
import { FileInputIcon, UploadIcon, XIcon } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { type DragEvent, useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui-kit/button";
import { Checkbox } from "@/components/ui/checkbox";
import { errorText } from "@/i18n/errors";
import { ApiRequestError, apiFetch } from "@/lib/api";
import { fmt, plural } from "@/i18n";
import { useT } from "@/i18n/client";
import { rich } from "@/i18n/rich";
import { cn } from "@/lib/utils";
import { Receipt } from "./receipt";

const ACCEPT = [".csv", ".xlsx", ".pdf"];

type Current =
  | { file: File; state: "loading" }
  | { file: File; state: "error"; message: string }
  | { file: File; state: "ready"; preview: ImportPreview };

interface Done {
  fileName: string;
  batchId: number;
  inserted: number;
  skippedDup: number;
  linked: number;
  autoSplit: number;
  month: string | null;
}

function form(file: File, force = false): FormData {
  const fd = new FormData();
  fd.set("file", file);
  if (force) fd.set("force", "1");
  return fd;
}

function accepted(file: File): boolean {
  const name = file.name.toLowerCase();
  return ACCEPT.some((ext) => name.endsWith(ext));
}

/** Drop zone → preview receipt → commit, one file at a time. */
export function ImportFlow() {
  const router = useRouter();
  const t = useT();
  const f = t.import.flow;
  const inputRef = useRef<HTMLInputElement>(null);
  const [queue, setQueue] = useState<File[]>([]);
  const [current, setCurrent] = useState<Current | null>(null);
  const [dragging, setDragging] = useState(false);
  const [acknowledged, setAcknowledged] = useState(false);
  const [committing, setCommitting] = useState(false);
  const [done, setDone] = useState<Done[]>([]);

  const loadPreview = useCallback(async (file: File) => {
    setCurrent({ file, state: "loading" });
    setAcknowledged(false);
    try {
      const preview = await apiFetch<ImportPreview>("/api/import/preview", { body: form(file), silent: true });
      setCurrent({ file, state: "ready", preview });
    } catch (e) {
      setCurrent({ file, state: "error", message: e instanceof ApiRequestError ? errorText(e, t) : f.cannotRead });
    }
  }, [t, f.cannotRead]);

  // Pull the next file off the queue whenever nothing is in progress.
  useEffect(() => {
    if (current || queue.length === 0) return;
    const [next, ...rest] = queue;
    setQueue(rest);
    if (next) void loadPreview(next);
  }, [current, queue, loadPreview]);

  function addFiles(list: FileList | File[]) {
    const files = [...list];
    const bad = files.filter((f) => !accepted(f));
    if (bad.length) toast.error(fmt(f.unsupported, { names: bad.map((x) => x.name).join(t.common.listSep) }));
    const good = files.filter(accepted);
    if (good.length) setQueue((q) => [...q, ...good]);
  }

  function onDrop(e: DragEvent) {
    e.preventDefault();
    setDragging(false);
    if (e.dataTransfer.files.length) addFiles(e.dataTransfer.files);
  }

  async function commit(force: boolean) {
    if (current?.state !== "ready") return;
    setCommitting(true);
    try {
      const r = await apiFetch<ImportResult>("/api/import/commit", { body: form(current.file, force) });
      const month = r.periodStart?.slice(0, 7) ?? null;
      setDone((d) => [
        {
          fileName: r.fileName,
          batchId: r.batchId,
          inserted: r.inserted,
          skippedDup: r.skippedDup,
          linked: r.linked,
          autoSplit: r.autoSplit,
          month,
        },
        ...d,
      ]);
      // The inline line below offers "View transactions"; the toast offers Undo (reverts the batch).
      toast.success(fmt(f.imported, { id: r.batchId, inserted: r.inserted, skipped: r.skippedDup }), {
        action: {
          label: t.common.undo,
          onClick: () => {
            void apiFetch<RevertResult>(`/api/import/batches/${r.batchId}/revert`, { method: "POST" })
              .then((out) => {
                toast(plural(t.import.revert.deleted, out.deleted));
                setDone((d) => d.filter((x) => x.batchId !== r.batchId));
                router.refresh();
              })
              .catch(() => {});
          },
        },
      });
      setCurrent(null);
      router.refresh();
    } catch {
      // apiFetch toasted the server message; keep the receipt so the user can decide again
    } finally {
      setCommitting(false);
    }
  }

  return (
    <div className="flex flex-col gap-6">
      <div
        onDragOver={(e) => {
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={onDrop}
        className={cn(
          "flex flex-col items-center gap-2 rounded-lg border border-dashed px-4 py-8 text-center transition-colors duration-[120ms]",
          dragging ? "border-primary bg-primary-soft" : "border-border bg-surface",
        )}
      >
        <UploadIcon className="size-4 text-2" aria-hidden />
        <p className="text-body">
          {f.drop}{" "}
          <button
            type="button"
            onClick={() => inputRef.current?.click()}
            className="hit relative rounded-sm text-primary underline-offset-4 hover:underline focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none"
          >
            {f.choose}
          </button>
        </p>
        <p className="text-meta text-2">{f.formats}</p>
        <p className="text-meta text-2">{t.import.description}</p>
        <input
          ref={inputRef}
          type="file"
          multiple
          accept={ACCEPT.join(",")}
          className="sr-only"
          tabIndex={-1}
          aria-label={f.chooseAria}
          onChange={(e) => {
            if (e.target.files) addFiles(e.target.files);
            e.target.value = "";
          }}
        />
      </div>

      {done.length > 0 && (
        <ul className="flex flex-col gap-1 text-body text-2">
          {done.map((d) => (
            <li key={d.batchId} className="flex flex-wrap items-baseline gap-x-2">
              <span>
                {rich(f.doneLine, {
                  file: <span className="text-foreground">{d.fileName}</span>,
                  id: d.batchId,
                  inserted: d.inserted,
                  skipped: d.skippedDup,
                })}
                {d.linked > 0 ? fmt(f.doneLinked, { count: d.linked }) : ""}
                {d.autoSplit > 0 ? fmt(f.doneAutoSplit, { count: d.autoSplit }) : ""}
              </span>
              {d.month && (
                <Link href={`/transactions?month=${d.month}`} className="text-primary underline-offset-4 hover:underline">
                  {f.viewTransactions}
                </Link>
              )}
            </li>
          ))}
        </ul>
      )}

      {current && (
        <section aria-label={f.previewLabel} className="rounded-xl border border-border bg-surface p-5">
          {current.state === "loading" && <p className="text-body text-2">{fmt(f.reading, { name: current.file.name })}</p>}

          {current.state === "error" && (
            <div className="flex flex-col gap-3">
              <p className="text-body">
                {current.file.name} <span className="text-2">{fmt(f.parseFailed, { message: current.message })}</span>
              </p>
              <div>
                <Button size="sm" onClick={() => setCurrent(null)}>
                  <XIcon aria-hidden />
                  {queue.length ? f.skipNext : t.common.close}
                </Button>
              </div>
            </div>
          )}

          {current.state === "ready" && (
            <div className="flex flex-col gap-5">
              <Receipt preview={current.preview} />

              {current.preview.alreadyImported && (
                <p className="rounded-md bg-sunken px-3 py-2 text-body text-2">
                  {fmt(f.alreadyImported, { id: current.preview.existingBatchId ?? "" })}
                </p>
              )}

              {!current.preview.reconciliation.ok && (
                <label className="flex items-center gap-2 text-body">
                  <Checkbox checked={acknowledged} onCheckedChange={(v) => setAcknowledged(v === true)} />
                  {f.acknowledge}
                </label>
              )}

              <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border pt-4">
                <span className="text-meta text-2">
                  {queue.length > 0
                    ? plural(f.queued, queue.length)
                    : fmt(f.sourceLine, { source: t.import.sources[current.preview.source] ?? current.preview.source })}
                </span>
                <div className="flex gap-2">
                  <Button variant="ghost" onClick={() => setCurrent(null)} disabled={committing}>
                    <XIcon aria-hidden />
                    {queue.length ? f.skip : t.common.cancel}
                  </Button>
                  {current.preview.alreadyImported ? (
                    <Button
                      variant="outline"
                      onClick={() => commit(true)}
                      disabled={committing || (!current.preview.reconciliation.ok && !acknowledged)}
                    >
                      <FileInputIcon aria-hidden />
                      {f.forceImport}
                    </Button>
                  ) : (
                    <Button
                      variant="primary"
                      phoneSoft
                      onClick={() => commit(false)}
                      disabled={committing || (!current.preview.reconciliation.ok && !acknowledged)}
                    >
                      <FileInputIcon aria-hidden />
                      {current.preview.reconciliation.ok ? f.confirm : f.importAnyway}
                    </Button>
                  )}
                </div>
              </div>
            </div>
          )}
        </section>
      )}

    </div>
  );
}
