"use client";

import { ArrowLeftIcon, CheckIcon, CircleAlertIcon, RotateCcwIcon } from "lucide-react";
import { type KeyboardEvent, type PointerEvent, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui-kit/button";
import { useT } from "@/i18n/client";
import { type Handle, HANDLES, moveRect, type Rect, resizeRect, type Size } from "@/lib/qr-crop";
import { cn } from "@/lib/utils";

/** Where each handle sits on the box, as CSS percentages of its width and height. */
const SPOT: Record<Handle, { left: string; top: string; cursor: string }> = {
  nw: { left: "0%", top: "0%", cursor: "nwse-resize" },
  n: { left: "50%", top: "0%", cursor: "ns-resize" },
  ne: { left: "100%", top: "0%", cursor: "nesw-resize" },
  e: { left: "100%", top: "50%", cursor: "ew-resize" },
  se: { left: "100%", top: "100%", cursor: "nwse-resize" },
  s: { left: "50%", top: "100%", cursor: "ns-resize" },
  sw: { left: "0%", top: "100%", cursor: "nesw-resize" },
  w: { left: "0%", top: "50%", cursor: "ew-resize" },
};

const ARROWS: Record<string, [number, number]> = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };

/**
 * The crop step of the payment method dialog ("Original" QR card): the screenshot (a local object URL) fitted to the
 * dialog, the part outside the box dimmed by the box's shadow (the frame clips it), the box dragged to move, eight handles to resize (pointer and touch; 44 px hit areas),
 * arrows to nudge the focused box or handle by 1 px of the image (Shift: 10), Reset back to the first fit. Back (or
 * Esc, handled by the dialog) returns to the form without changing anything; "Use this crop" hands the box over.
 */
export function QrCropStep({
  src,
  image,
  initial,
  fitted,
  busy,
  error,
  onBack,
  onApply,
}: {
  src: string;
  image: Size;
  initial: Rect;
  /** The first fit (from the QR's location), for Reset. */
  fitted: Rect;
  busy: boolean;
  error: string | null;
  onBack: () => void;
  onApply: (rect: Rect) => void;
}) {
  const t = useT();
  const s = t.settings.payment;
  const [rect, setRect] = useState(initial);
  const frame = useRef<HTMLDivElement>(null);
  const box = useRef<HTMLDivElement>(null);
  const drag = useRef<{ id: number; handle: Handle | null; x: number; y: number; start: Rect } | null>(null);

  useEffect(() => {
    box.current?.focus({ preventScroll: true });
  }, []);

  const perPixel = () => image.width / (frame.current?.getBoundingClientRect().width || image.width);

  const down = (handle: Handle | null) => (e: PointerEvent<HTMLElement>) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    e.currentTarget.setPointerCapture(e.pointerId);
    e.currentTarget.focus({ preventScroll: true });
    drag.current = { id: e.pointerId, handle, x: e.clientX, y: e.clientY, start: rect };
  };
  const move = (e: PointerEvent<HTMLElement>) => {
    const d = drag.current;
    if (!d || d.id !== e.pointerId) return;
    const k = perPixel();
    const dx = (e.clientX - d.x) * k;
    const dy = (e.clientY - d.y) * k;
    setRect(d.handle ? resizeRect(d.start, d.handle, dx, dy, image) : moveRect(d.start, dx, dy, image));
  };
  const up = (e: PointerEvent<HTMLElement>) => {
    if (drag.current?.id === e.pointerId) drag.current = null;
  };
  const nudge = (handle: Handle | null) => (e: KeyboardEvent<HTMLElement>) => {
    const arrow = ARROWS[e.key];
    if (!arrow) return;
    e.preventDefault();
    e.stopPropagation();
    const step = e.shiftKey ? 10 : 1;
    const [dx, dy] = [arrow[0] * step, arrow[1] * step];
    setRect((r) => (handle ? resizeRect(r, handle, dx, dy, image) : moveRect(r, dx, dy, image)));
  };

  const pct = (v: number, of: number) => `${(v / of) * 100}%`;
  const ratio = image.width / image.height;

  return (
    <div className="flex flex-col gap-4" data-testid="qr-crop">
      <div
        ref={frame}
        className="relative mx-auto touch-none overflow-hidden rounded-lg bg-sunken select-none"
        style={{ width: `min(100%, calc(56dvh * ${ratio}))`, aspectRatio: `${image.width} / ${image.height}` }}
      >
        <img src={src} alt="" draggable={false} className="pointer-events-none absolute inset-0 size-full" />
        <div
          ref={box}
          role="group"
          tabIndex={0}
          aria-label={s.cropBox}
          aria-describedby="qr-crop-keys"
          data-testid="qr-crop-box"
          data-rect={`${rect.x},${rect.y},${rect.width},${rect.height}`}
          onPointerDown={down(null)}
          onPointerMove={move}
          onPointerUp={up}
          onPointerCancel={up}
          onKeyDown={nudge(null)}
          className="absolute cursor-move border-[1.5px] border-white shadow-[0_0_0_100vmax_rgb(0_0_0/0.55)] outline-none focus-visible:ring-2 focus-visible:ring-primary"
          style={{
            left: pct(rect.x, image.width),
            top: pct(rect.y, image.height),
            width: pct(rect.width, image.width),
            height: pct(rect.height, image.height),
          }}
        >
          {HANDLES.map((h) => (
            <span
              key={h}
              role="button"
              tabIndex={0}
              aria-label={s.cropHandles[h]}
              data-handle={h}
              onPointerDown={down(h)}
              onPointerMove={move}
              onPointerUp={up}
              onPointerCancel={up}
              onKeyDown={nudge(h)}
              className="group absolute flex size-11 -translate-x-1/2 -translate-y-1/2 items-center justify-center outline-none md:size-6"
              style={{ left: SPOT[h].left, top: SPOT[h].top, cursor: SPOT[h].cursor }}
            >
              <span
                aria-hidden
                className={cn(
                  "block rounded-[3px] border border-black/40 bg-white shadow-sm group-focus-visible:ring-2 group-focus-visible:ring-primary",
                  h.length === 2 ? "size-3.5" : h === "n" || h === "s" ? "h-2 w-5" : "h-5 w-2",
                )}
              />
            </span>
          ))}
        </div>
      </div>
      <p id="qr-crop-keys" className="text-hint text-3">
        {s.cropKeys}
      </p>
      {error && (
        <p role="alert" className="flex items-center gap-1.5 text-meta" data-testid="qr-crop-error">
          <CircleAlertIcon className="size-3.5 shrink-0 text-2" aria-hidden />
          {error}
        </p>
      )}
      <div className="flex flex-wrap items-center justify-end gap-2">
        <Button type="button" variant="ghost" className="mr-auto" onClick={onBack}>
          <ArrowLeftIcon aria-hidden />
          {s.cropBack}
        </Button>
        <Button type="button" variant="outline" onClick={() => setRect(fitted)}>
          <RotateCcwIcon aria-hidden />
          {s.cropReset}
        </Button>
        <Button type="button" variant="primary" className="max-sm:w-full" disabled={busy} onClick={() => onApply(rect)}>
          <CheckIcon aria-hidden />
          {busy ? s.cropWorking : s.cropUse}
        </Button>
      </div>
    </div>
  );
}

/** A box of a local image drawn by CSS (no encoding): the "Original" preview while the screenshot is at hand. */
export function CropPreview({
  src,
  image,
  rect,
  maxHeight,
  className,
}: {
  src: string;
  image: Size;
  rect: Rect;
  /** CSS px; the width follows the box's aspect ratio, within the container. */
  maxHeight: number;
  className?: string;
}) {
  return (
    <span
      className={cn("relative block overflow-hidden", className)}
      style={{ aspectRatio: `${rect.width} / ${rect.height}`, width: `min(100%, ${(maxHeight * rect.width) / rect.height}px)` }}
    >
      <img
        src={src}
        alt=""
        draggable={false}
        className="absolute max-w-none"
        style={{
          width: `${(image.width / rect.width) * 100}%`,
          left: `${(-rect.x / rect.width) * 100}%`,
          top: `${(-rect.y / rect.height) * 100}%`,
        }}
      />
    </span>
  );
}
