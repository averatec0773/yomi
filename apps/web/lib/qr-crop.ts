/**
 * Geometry for the "Original" QR card crop (Settings > Profile > Payment methods): pure functions in image pixels, no
 * DOM, so they run in unit tests. The browser side (decoding, drawing, encoding) is in `qr-decode.ts` and
 * `components/payment/qr-crop.tsx`.
 */

export interface Point {
  x: number;
  y: number;
}
export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}
export interface Size {
  width: number;
  height: number;
}
/** A drag handle: the edges it moves ("n" top, "s" bottom, "w" left, "e" right). */
export type Handle = "n" | "s" | "e" | "w" | "ne" | "nw" | "se" | "sw";
export const HANDLES: readonly Handle[] = ["nw", "n", "ne", "e", "se", "s", "sw", "w"];

/** The smallest crop side, in image pixels. */
export const MIN_CROP = 24;
/** The stored image is at most this wide (CSS: about 160 px on screen at 2x, 36 mm on paper at over 400 dpi). */
export const ORIGINAL_MAX_WIDTH = 600;

/** The axis-aligned box around the QR code's corners (BarcodeDetector `cornerPoints` or jsQR `location`). */
export function boxOf(points: readonly Point[]): Rect {
  const xs = points.map((p) => p.x);
  const ys = points.map((p) => p.y);
  const x = Math.min(...xs);
  const y = Math.min(...ys);
  return { x, y, width: Math.max(...xs) - x, height: Math.max(...ys) - y };
}

/** `rect` moved and shrunk to lie inside the image, at least MIN_CROP (or the image) on each side, in whole pixels. */
export function clampRect(rect: Rect, image: Size): Rect {
  const width = Math.round(Math.min(image.width, Math.max(Math.min(MIN_CROP, image.width), rect.width)));
  const height = Math.round(Math.min(image.height, Math.max(Math.min(MIN_CROP, image.height), rect.height)));
  const x = Math.round(Math.min(Math.max(0, rect.x), image.width - width));
  const y = Math.round(Math.min(Math.max(0, rect.y), image.height - height));
  return { x, y, width, height };
}

/**
 * The first crop for a QR card: 1.5 times the QR's side wide, centered on it; from 0.9 sides above the QR (where the
 * name and the logo usually sit) to a quarter side below it; clamped to the image.
 */
export function autoCropRect(qr: Rect, image: Size): Rect {
  const side = Math.max(qr.width, qr.height);
  const cx = qr.x + qr.width / 2;
  const left = Math.max(0, cx - side * 0.75);
  const right = Math.min(image.width, cx + side * 0.75);
  const top = Math.max(0, qr.y - side * 0.9);
  const bottom = Math.min(image.height, qr.y + qr.height + side * 0.25);
  return clampRect({ x: left, y: top, width: right - left, height: bottom - top }, image);
}

/** RGBA pixels, as ImageData or pngjs give them. */
export interface Pixels extends Size {
  data: Uint8ClampedArray | Uint8Array;
}

/** How far a color may drift from the card's and still count as the card (sum of the RGB differences). */
const SAME = 48;
/** A line is off the card when this share of it differs from the card color... */
const OFF_SHARE = 0.85;
/** ...for this many lines in a row (a hairline or a line of text inside the card never is). */
const OFF_RUN = 4;

/**
 * The card's edges around the QR code, where a clear background change is found: from just outside the QR's quiet zone,
 * each side walks outward line by line, and the first run of lines that are almost entirely unlike the card color
 * (sampled next to the QR) marks the edge. A side keeps `rect`'s edge when no change is found within reach (the top
 * reaches 2 QR sides up, for the name and logo; the other sides one side), so a card that fills the screenshot keeps
 * the default crop. The result always holds the QR with a margin.
 */
export function snapToCard(rect: Rect, qr: Rect, px: Pixels): Rect {
  const side = Math.max(qr.width, qr.height);
  const quiet = Math.max(2, Math.round(side * 0.04));
  const color = (x: number, y: number): [number, number, number] => {
    const i = (Math.round(y) * px.width + Math.round(x)) * 4;
    return [px.data[i]!, px.data[i + 1]!, px.data[i + 2]!];
  };
  const inImage = (x: number, y: number) => x >= 0 && y >= 0 && x < px.width && y < px.height;
  const diff = (a: [number, number, number], b: [number, number, number]) => Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]) + Math.abs(a[2] - b[2]);

  /** Samples along a line: across the QR's span, 48 points. */
  const samples = (horizontal: boolean, at: number): [number, number][] => {
    const from = horizontal ? qr.x : qr.y;
    const span = horizontal ? qr.width : qr.height;
    return Array.from({ length: 48 }, (_, k) => {
      const t = from + (span * (k + 0.5)) / 48;
      return horizontal ? [t, at] : [at, t];
    });
  };
  const median = (cs: [number, number, number][]): [number, number, number] =>
    [0, 1, 2].map((c) => cs.map((v) => v[c]!).sort((a, b) => a - b)[cs.length >> 1]!) as [number, number, number];

  /** The first off-card line from `start` stepping by `dir` (up to `reach` lines), or null. */
  const edge = (horizontal: boolean, start: number, dir: 1 | -1, reach: number): number | null => {
    const first = samples(horizontal, start).filter(([x, y]) => inImage(x, y));
    if (first.length < 24) return null;
    const card = median(first.map(([x, y]) => color(x, y)));
    let run = 0;
    for (let k = 1; k <= reach; k++) {
      const at = start + dir * k;
      const pts = samples(horizontal, at).filter(([x, y]) => inImage(x, y));
      if (pts.length < 24) return null;
      const off = pts.filter(([x, y]) => diff(color(x, y), card) > SAME).length / pts.length;
      run = off >= OFF_SHARE ? run + 1 : 0;
      if (run === OFF_RUN) return at - dir * (OFF_RUN - 1);
    }
    return null;
  };

  const qrTop = qr.y;
  const qrBottom = qr.y + qr.height;
  const qrLeft = qr.x;
  const qrRight = qr.x + qr.width;
  const top = edge(true, qrTop - quiet, -1, Math.round(side * 2));
  const bottom = edge(true, qrBottom + quiet, 1, Math.round(side));
  const left = edge(false, qrLeft - quiet, -1, Math.round(side));
  const right = edge(false, qrRight + quiet, 1, Math.round(side));

  const y0 = top !== null ? top + 1 : rect.y;
  const y1 = bottom !== null ? bottom : rect.y + rect.height;
  const x0 = left !== null ? left + 1 : rect.x;
  const x1 = right !== null ? right : rect.x + rect.width;
  // Never tighter than the QR and its quiet zone.
  const snapped = {
    x: Math.min(x0, qrLeft - quiet),
    y: Math.min(y0, qrTop - quiet),
    width: 0,
    height: 0,
  };
  snapped.width = Math.max(x1, qrRight + quiet) - snapped.x;
  snapped.height = Math.max(y1, qrBottom + quiet) - snapped.y;
  return clampRect(snapped, px);
}

/** `rect` moved by (dx, dy), kept inside the image. */
export function moveRect(rect: Rect, dx: number, dy: number, image: Size): Rect {
  return clampRect({ ...rect, x: rect.x + dx, y: rect.y + dy }, image);
}

/**
 * `rect` with the edges of `handle` moved by (dx, dy): each moved edge stays inside the image and at least MIN_CROP
 * from the opposite one, which does not move.
 */
export function resizeRect(rect: Rect, handle: Handle, dx: number, dy: number, image: Size): Rect {
  let left = rect.x;
  let top = rect.y;
  let right = rect.x + rect.width;
  let bottom = rect.y + rect.height;
  const min = (n: number) => Math.min(MIN_CROP, n);
  if (handle.includes("w")) left = Math.min(Math.max(0, left + dx), right - min(right));
  if (handle.includes("e")) right = Math.max(Math.min(image.width, right + dx), left + min(image.width - left));
  if (handle.includes("n")) top = Math.min(Math.max(0, top + dy), bottom - min(bottom));
  if (handle.includes("s")) bottom = Math.max(Math.min(image.height, bottom + dy), top + min(image.height - top));
  return { x: Math.round(left), y: Math.round(top), width: Math.round(right - left), height: Math.round(bottom - top) };
}

/** The stored size of a crop: at most ORIGINAL_MAX_WIDTH wide (never scaled up), the aspect ratio kept. */
export function storedSize(crop: Size, maxWidth = ORIGINAL_MAX_WIDTH): Size {
  const width = Math.max(1, Math.min(maxWidth, Math.round(crop.width)));
  return { width, height: Math.max(1, Math.round((crop.height * width) / crop.width)) };
}
