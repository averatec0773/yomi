"use client";

// The QR part of the payment method dialog: import from an image, a paste or link text, and the Clean / Original choice.

import { linkText, type PaymentKind, type PaymentMethod, paymentLink } from "@yomi/core/payment";
import { CircleAlertIcon, ImageUpIcon, LinkIcon, QrCodeIcon, XIcon } from "lucide-react";
import { type ReactNode, type Ref, useEffect, useRef, useState } from "react";
import { TextInput } from "@/components/split/ui";
import { Button } from "@/components/ui-kit/button";
import { fmt } from "@/i18n";
import { useT } from "@/i18n/client";
import { type QrRead, readQrImage } from "@/lib/qr-decode";
import { cn } from "@/lib/utils";
import { QrCode } from "./qr-code";

const QR_MAX = 2048;

/**
 * "Add QR code" for one method: drop or pick a screenshot or photo, paste an image with ⌘V while the dialog is open,
 * or paste the code's link text. Images are decoded here (BarcodeDetector or jsQR): `onImage` gets the text, where the
 * code sits and the image (for the Original crop, kept in memory only); link text goes to `onChange`. `choice` (the
 * Clean / Original previews) replaces the single preview when there is an image to choose from.
 */
export function QrField({
  kind,
  username,
  value,
  name,
  choice,
  onChange,
  onImage,
}: {
  kind: PaymentKind;
  username: string;
  value: string | null;
  name: string;
  choice?: ReactNode;
  onChange: (qr: string | null) => void;
  onImage: (read: QrRead, file: Blob) => Promise<void>;
}) {
  const t = useT();
  const s = t.settings.payment;
  const [state, setState] = useState<"idle" | "reading" | "error">("idle");
  const [link, setLink] = useState("");
  const [over, setOver] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const change = useRef(onChange);
  useEffect(() => {
    change.current = onChange;
  });

  const read = async (file: Blob) => {
    setState("reading");
    const found = await readQrImage(file);
    if (found) {
      await onImage({ ...found, text: found.text.slice(0, QR_MAX) }, file);
      setState("idle");
    } else setState("error");
  };
  const readRef = useRef(read);
  useEffect(() => {
    readRef.current = read;
  });

  useEffect(() => {
    const onPaste = (e: ClipboardEvent) => {
      const image = [...(e.clipboardData?.files ?? [])].find((f) => f.type.startsWith("image/"));
      if (image) {
        e.preventDefault();
        void readRef.current(image);
        return;
      }
      // Link text pasted outside a text field is the QR's payload too.
      const target = e.target as HTMLElement | null;
      if (target?.closest("input, textarea, [contenteditable=true]")) return;
      const text = e.clipboardData?.getData("text/plain").trim();
      if (text && !text.includes("\n")) {
        e.preventDefault();
        change.current(text.slice(0, QR_MAX));
        setState("idle");
      }
    };
    document.addEventListener("paste", onPaste);
    return () => document.removeEventListener("paste", onPaste);
  }, []);

  const picker = (
    <input
      ref={fileRef}
      type="file"
      accept="image/*,.heic,.heif"
      className="sr-only"
      tabIndex={-1}
      aria-hidden
      data-testid="qr-file"
      onChange={(e) => {
        const file = e.target.files?.[0];
        e.target.value = "";
        if (file) void read(file);
      }}
    />
  );
  const built = kind === "venmo" || kind === "paypal" || kind === "cashapp" ? paymentLink({ kind, username }) : null;

  return (
    <div className="flex flex-col gap-2" data-testid="qr-field">
      <span className="text-meta text-2">{s.qr}</span>
      {kind === "zelle" && <p className="text-meta text-2">{s.zelleHelp}</p>}
      {value ? (
        <div className={cn("flex gap-4 rounded-lg border border-border bg-surface p-3", choice ? "flex-col" : "items-start")}>
          {choice ?? <QrCode value={value} label={fmt(s.qrImage, { name })} className="size-24" testId="settings-qr" />}
          <div className="flex min-w-0 flex-1 flex-col gap-2">
            <p className="text-meta break-all text-2" data-testid="qr-payload">
              {value}
            </p>
            <div className="flex flex-wrap gap-2">
              <Button type="button" variant="outline" size="sm" onClick={() => fileRef.current?.click()}>
                <ImageUpIcon aria-hidden />
                {s.qrReplace}
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => {
                  onChange(null);
                  setState("idle");
                }}
              >
                <XIcon aria-hidden />
                {s.qrRemove}
              </Button>
            </div>
          </div>
        </div>
      ) : (
        <>
          <div
            data-testid="qr-drop"
            data-over={over || undefined}
            onDragOver={(e) => {
              e.preventDefault();
              setOver(true);
            }}
            onDragLeave={() => setOver(false)}
            onDrop={(e) => {
              e.preventDefault();
              setOver(false);
              const file = [...e.dataTransfer.files].find((f) => f.type.startsWith("image/") || /\.(heic|heif)$/i.test(f.name));
              if (file) void read(file);
              else setState("error");
            }}
            className="flex flex-col items-start gap-2 rounded-lg border border-dashed border-line-strong p-4 transition-colors duration-[120ms] data-[over]:border-primary data-[over]:bg-primary-soft"
          >
            <p className="flex items-center gap-2 text-body font-medium">
              <QrCodeIcon className="size-4 text-2" aria-hidden />
              {s.addQr}
            </p>
            <p className="text-meta text-2">{s.qrDrop}</p>
            <Button type="button" variant="outline" size="sm" onClick={() => fileRef.current?.click()}>
              <ImageUpIcon aria-hidden />
              {s.qrChoose}
            </Button>
          </div>
          <div className="flex gap-2">
            <TextInput
              value={link}
              maxLength={QR_MAX}
              placeholder={s.qrLink}
              aria-label={s.qrLink}
              onChange={(e) => setLink(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && link.trim()) {
                  e.preventDefault();
                  onChange(link.trim());
                  setLink("");
                }
              }}
            />
            <Button
              type="button"
              variant="outline"
              className="h-9 shrink-0"
              disabled={!link.trim()}
              onClick={() => {
                onChange(link.trim());
                setLink("");
                setState("idle");
              }}
            >
              <LinkIcon aria-hidden />
              {s.qrUseLink}
            </Button>
          </div>
          {kind === "zelle" && <p className="text-meta text-2">{s.zelleNoQr}</p>}
          {built && <p className="text-meta text-2">{fmt(s.qrFromLink, { link: linkText(built) })}</p>}
        </>
      )}
      {picker}
      {state === "reading" && (
        <p className="text-meta text-2" aria-live="polite">
          {s.qrReading}
        </p>
      )}
      {state === "error" && (
        <p role="alert" className="flex items-center gap-1.5 text-meta" data-testid="qr-error">
          <CircleAlertIcon className="size-3.5 shrink-0 text-2" aria-hidden />
          {s.qrError}
        </p>
      )}
    </div>
  );
}

/**
 * "Show on statements as": Clean (the QR drawn from its payload) or Original (the user's own crop of the screenshot),
 * side by side as two radio tiles with their previews.
 */
export function DisplayChoice({
  value,
  qr,
  name,
  original,
  onClean,
  onOriginal,
  originalRef,
}: {
  value: PaymentMethod["display"];
  qr: string;
  name: string;
  original: ReactNode;
  onClean: () => void;
  onOriginal: () => void;
  originalRef: Ref<HTMLInputElement>;
}) {
  const t = useT();
  const s = t.settings.payment;
  const tile = (on: boolean) =>
    cn(
      "flex min-w-0 flex-1 cursor-pointer flex-col items-center gap-2 rounded-lg border p-3 transition-colors duration-[120ms] has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-ring/50",
      on ? "border-primary bg-primary-soft" : "border-border hover:bg-sunken",
    );
  return (
    <fieldset data-testid="qr-display">
      <legend className="mb-2 text-meta text-2">{s.displayAs}</legend>
      <div className="flex gap-3">
        <label className={tile(value === "clean")}>
          <span className="flex h-28 items-center justify-center">
            <QrCode value={qr} label={fmt(s.qrImage, { name })} className="size-24" testId="settings-qr" />
          </span>
          <span className="flex items-center gap-2 text-body">
            <input type="radio" name="qr-display" className="size-4 accent-primary" checked={value === "clean"} onChange={onClean} />
            {s.displayClean}
          </span>
        </label>
        <label className={tile(value === "original")}>
          <span className="flex h-28 w-full items-center justify-center">{original}</span>
          <span className="flex items-center gap-2 text-body">
            <input
              ref={originalRef}
              type="radio"
              name="qr-display"
              className="size-4 accent-primary"
              checked={value === "original"}
              onChange={onOriginal}
              onClick={() => {
                // Choosing Original again (already selected) reopens the crop.
                if (value === "original") onOriginal();
              }}
            />
            {s.displayOriginal}
          </span>
        </label>
      </div>
    </fieldset>
  );
}
