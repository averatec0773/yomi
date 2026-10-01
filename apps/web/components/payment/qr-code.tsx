import QRCode from "qrcode";
import { cn } from "@/lib/utils";

/** Modules around the code (the QR quiet zone), part of the light tile. */
const QUIET = 4;

/** The dark modules of `value` as one SVG path in module units, or null when it does not fit in a QR code. */
export function qrModules(value: string): { size: number; d: string } | null {
  try {
    const { modules } = QRCode.create(value, { errorCorrectionLevel: "M" });
    let d = "";
    for (let y = 0; y < modules.size; y++) {
      for (let x = 0; x < modules.size; x++) {
        if (modules.get(y, x)) d += `M${x + QUIET} ${y + QUIET}h1v1h-1z`;
      }
    }
    return { size: modules.size, d };
  } catch {
    return null;
  }
}

/**
 * A QR code drawn crisply from its payload (never a stored image): dark modules on a light tile with the quiet zone,
 * in the light palette even on dark paper so any phone can scan it. Server and client (no hooks). Size it with
 * `className` (e.g. `size-24`).
 */
export function QrCode({ value, label, className, testId }: { value: string; label: string; className?: string; testId?: string }) {
  const qr = qrModules(value);
  if (!qr) return null;
  const n = qr.size + QUIET * 2;
  return (
    <svg
      viewBox={`0 0 ${n} ${n}`}
      role="img"
      aria-label={label}
      shapeRendering="crispEdges"
      data-testid={testId}
      data-qr={value}
      className={cn("light block shrink-0", className)}
    >
      <rect width={n} height={n} rx={2} className="fill-surface" />
      <path d={qr.d} className="fill-foreground" />
    </svg>
  );
}
