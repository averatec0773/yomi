"use client";

import { ArrowLeftIcon, CopyIcon, FileDownIcon, ImageIcon, PrinterIcon } from "lucide-react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useEffect, useState, useTransition } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui-kit/button";
import { Switch } from "@/components/ui-kit/switch";
import { saveWhitePaper } from "./statement-scope";

/** Margin of paper color around the card in the saved image, in CSS px; the image is drawn at 2x. */
const IMAGE_MARGIN = 32;
const IMAGE_SCALE = 2;

/**
 * The preview's paper ([data-print-paper]: the 960px card in the current paper mode and theme) as one PNG at 2x, on a
 * 32px margin of the paper color, fonts embedded (after document.fonts.ready). The toolbar is outside the paper.
 * QR codes are SVG, so they stay sharp at any scale.
 */
export async function statementPng(): Promise<Blob> {
  const paper = document.querySelector<HTMLElement>("[data-print-paper]");
  if (!paper) throw new Error("No statement on this page");
  await document.fonts.ready;
  const { domToCanvas } = await import("modern-screenshot");
  const background = getComputedStyle(paper).backgroundColor;
  const card = await domToCanvas(paper, { scale: IMAGE_SCALE, backgroundColor: background });
  const pad = IMAGE_MARGIN * IMAGE_SCALE;
  const out = document.createElement("canvas");
  out.width = card.width + pad * 2;
  out.height = card.height + pad * 2;
  const ctx = out.getContext("2d");
  if (!ctx) throw new Error("No 2D canvas");
  ctx.fillStyle = background;
  ctx.fillRect(0, 0, out.width, out.height);
  ctx.drawImage(card, pad, pad);
  return new Promise((resolve, reject) => out.toBlob((b) => (b ? resolve(b) : reject(new Error("PNG encoding failed"))), "image/png"));
}

function canCopyImage(): boolean {
  if (typeof ClipboardItem === "undefined" || typeof navigator.clipboard?.write !== "function") return false;
  const supports = (ClipboardItem as unknown as { supports?: (type: string) => boolean }).supports;
  return supports ? supports("image/png") : true;
}

/**
 * "Save as image" and, where the browser can put a PNG on the clipboard, "Copy image" on the print view's toolbar:
 * the paper as one long PNG, no page breaks. The button reads "Rendering…" meanwhile; a toast says when it is done or
 * why not (calm sentences from the error dictionary, passed in the statement's language).
 */
export function ImageButtons({
  fileName,
  labels,
}: {
  fileName: string;
  labels: { save: string; copy: string; working: string; saved: string; copied: string; failed: string; copyFailed: string };
}) {
  const [busy, setBusy] = useState<"save" | "copy" | null>(null);
  const [copyable, setCopyable] = useState(false);
  useEffect(() => setCopyable(canCopyImage()), []);

  const save = async () => {
    setBusy("save");
    try {
      const url = URL.createObjectURL(await statementPng());
      const a = document.createElement("a");
      a.href = url;
      a.download = fileName;
      document.body.append(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 10_000);
      toast.success(labels.saved);
    } catch {
      toast.error(labels.failed);
    } finally {
      setBusy(null);
    }
  };
  const copy = async () => {
    setBusy("copy");
    try {
      // The promise goes into the ClipboardItem right away, so Safari still sees the click's user activation.
      await navigator.clipboard.write([new ClipboardItem({ "image/png": statementPng() })]);
      toast.success(labels.copied);
    } catch {
      toast.error(labels.copyFailed);
    } finally {
      setBusy(null);
    }
  };

  return (
    <>
      {copyable && (
        <Button variant="outline" disabled={busy !== null} aria-busy={busy === "copy"} onClick={() => void copy()}>
          <CopyIcon aria-hidden />
          {busy === "copy" ? labels.working : labels.copy}
        </Button>
      )}
      <Button variant="outline" disabled={busy !== null} aria-busy={busy === "save"} onClick={() => void save()}>
        <ImageIcon aria-hidden />
        {busy === "save" ? labels.working : labels.save}
      </Button>
    </>
  );
}

/** "Print preview" in the statement dialog footer: opens the print view (current scope and options) in a new tab. */
export function PrintPreviewLink({ href, label }: { href: string; label: string }) {
  return (
    <Button variant="outline" asChild>
      {/* rel=opener so "Back to statement" on the preview can close its tab and return here. */}
      <a href={href} target="_blank" rel="opener">
        <PrinterIcon aria-hidden />
        {label}
      </a>
    </Button>
  );
}

/**
 * "Save as PDF" (primary) or "Print" on the print view. Both open the browser's print dialog; only the label and the
 * hint under the toolbar differ, since Save as PDF is a destination in that dialog.
 */
export function PrintButton({ label, kind }: { label: string; kind: "pdf" | "print" }) {
  return (
    <Button variant={kind === "pdf" ? "primary" : "outline"} onClick={() => window.print()}>
      {kind === "pdf" ? <FileDownIcon aria-hidden /> : <PrinterIcon aria-hidden />}
      {label}
    </Button>
  );
}

/** "Back to statement": closes the preview tab when the statement opened it, otherwise goes to /split. */
export function BackToStatement({ label }: { label: string }) {
  return (
    <Button variant="ghost" asChild>
      <a
        href="/split"
        onClick={(e) => {
          if (!window.opener) return;
          e.preventDefault();
          window.close();
          // close() can be refused (the tab was not opened by script): follow the link instead.
          setTimeout(() => {
            if (!window.closed) window.location.assign("/split");
          }, 150);
        }}
      >
        <ArrowLeftIcon aria-hidden />
        {label}
      </a>
    </Button>
  );
}

/**
 * "Print on white paper" on the print view's toolbar: flips the paper in place (colors=light in the URL) and is
 * remembered for this person, like the same switch in the statement's Options.
 */
export function PaperToggle({ participantId, whitePaper, label }: { participantId: number; whitePaper: boolean; label: string }) {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const [pending, startTransition] = useTransition();
  return (
    <Switch
      label={label}
      checked={whitePaper}
      disabled={pending}
      className="w-auto"
      onChange={(next) => {
        saveWhitePaper(participantId, next);
        const q = new URLSearchParams(params.toString());
        if (next) q.set("colors", "light");
        else q.delete("colors");
        startTransition(() => router.replace(`${pathname}?${q.toString()}`, { scroll: false }));
      }}
    />
  );
}

/**
 * Screen colors on the print view: pins the theme the screen shows as `.dark` or `.light` on <html> (html[data-theme]
 * when the user chose one, else prefers-color-scheme, followed while on screen), so the paper and the @page margin
 * colors never depend on prefers-color-scheme while printing (Chrome's print preview evaluates it as light). From
 * beforeprint to afterprint the value pinned on screen is kept, whatever the media query reports meanwhile; the next
 * change on screen updates it again.
 */
export function PinScreenTheme() {
  useEffect(() => {
    const root = document.documentElement;
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    let printing = false;
    const resolve = () => {
      if (printing) return;
      const chosen = root.dataset.theme;
      const dark = chosen === "dark" || (chosen !== "light" && media.matches);
      root.classList.toggle("dark", dark);
      root.classList.toggle("light", !dark);
    };
    // No re-read around printing: the media query may already (or still) report the print preview's light scheme.
    const before = () => {
      printing = true;
    };
    const after = () => {
      printing = false;
    };
    resolve();
    media.addEventListener("change", resolve);
    window.addEventListener("beforeprint", before);
    window.addEventListener("afterprint", after);
    return () => {
      media.removeEventListener("change", resolve);
      window.removeEventListener("beforeprint", before);
      window.removeEventListener("afterprint", after);
      root.classList.remove("dark", "light");
    };
  }, []);
  return null;
}
