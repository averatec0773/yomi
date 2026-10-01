import jsQR from "jsqr";
import { boxOf, type Point, type Rect, storedSize } from "./qr-crop";

/** A decoded QR code: its text and, when the decoder reports it, its corners in the image's pixels. */
export interface QrRead {
  text: string;
  corners: Point[] | null;
}

interface Detector {
  detect(image: ImageBitmapSource): Promise<{ rawValue: string; cornerPoints?: Point[] }[]>;
}
interface DetectorClass {
  new (options: { formats: string[] }): Detector;
  getSupportedFormats?: () => Promise<string[]>;
}

async function withBarcodeDetector(bitmap: ImageBitmap): Promise<QrRead | null> {
  const BarcodeDetector = (globalThis as { BarcodeDetector?: DetectorClass }).BarcodeDetector;
  if (!BarcodeDetector) return null;
  try {
    const formats = (await BarcodeDetector.getSupportedFormats?.()) ?? ["qr_code"];
    if (!formats.includes("qr_code")) return null;
    const codes = await new BarcodeDetector({ formats: ["qr_code"] }).detect(bitmap);
    const code = codes.find((c) => c.rawValue);
    if (!code) return null;
    const corners = code.cornerPoints?.length === 4 ? code.cornerPoints.map(({ x, y }) => ({ x, y })) : null;
    return { text: code.rawValue, corners };
  } catch {
    return null;
  }
}

/** jsQR on a canvas at a few sizes, with a white margin (a tight crop may cut the quiet zone). */
function withJsQr(bitmap: ImageBitmap): QrRead | null {
  const longest = Math.max(bitmap.width, bitmap.height);
  const sizes = [...new Set([1200, 800, 500, 2000].map((max) => Math.min(max, longest)))];
  for (const max of sizes) {
    const scale = max / longest;
    const w = Math.max(1, Math.round(bitmap.width * scale));
    const h = Math.max(1, Math.round(bitmap.height * scale));
    const pad = Math.round(Math.max(w, h) * 0.08);
    const canvas = document.createElement("canvas");
    canvas.width = w + pad * 2;
    canvas.height = h + pad * 2;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    if (!ctx) return null;
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(bitmap, pad, pad, w, h);
    const { data, width, height } = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const code = jsQR(data, width, height, { inversionAttempts: "attemptBoth" });
    if (code?.data) {
      const l = code.location;
      // Back from the padded, scaled canvas to the image's own pixels.
      const back = (p: Point) => ({ x: (p.x - pad) / scale, y: (p.y - pad) / scale });
      return { text: code.data, corners: [l.topLeftCorner, l.topRightCorner, l.bottomRightCorner, l.bottomLeftCorner].map(back) };
    }
  }
  return null;
}

/** The QR code in a decoded image: BarcodeDetector when the browser has one, else jsQR. */
export async function readQrBitmap(bitmap: ImageBitmap): Promise<QrRead | null> {
  const read = (await withBarcodeDetector(bitmap)) ?? withJsQr(bitmap);
  const text = read?.text.trim();
  return read && text ? { ...read, text } : null;
}

/**
 * The QR code in an image (a screenshot or photo: PNG, JPG, HEIC where the browser decodes it), or null: its text and
 * where it sits. Everything stays in the browser.
 */
export async function readQrImage(file: Blob): Promise<QrRead | null> {
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    return null;
  }
  try {
    return await readQrBitmap(bitmap);
  } finally {
    bitmap.close();
  }
}

/** The text inside a QR code in an image, or null. */
export async function decodeQrImage(file: Blob): Promise<string | null> {
  return (await readQrImage(file))?.text ?? null;
}

/** The QR's box in the image, from the decoder's corners. */
export function qrBox(read: QrRead): Rect | null {
  return read.corners ? boxOf(read.corners) : null;
}

/** The RGBA pixels of a bitmap (for finding the card's edges). */
export function bitmapPixels(bitmap: ImageBitmap): ImageData | null {
  const canvas = document.createElement("canvas");
  canvas.width = bitmap.width;
  canvas.height = bitmap.height;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) return null;
  ctx.drawImage(bitmap, 0, 0);
  return ctx.getImageData(0, 0, bitmap.width, bitmap.height);
}

function toBlob(canvas: HTMLCanvasElement, type: string, quality?: number): Promise<Blob | null> {
  return new Promise((resolve) => canvas.toBlob(resolve, type, quality));
}

function toDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(reader.error ?? new Error("Could not read the image"));
    reader.readAsDataURL(blob);
  });
}

/** A crop as stored: a WebP (else PNG) data URL and its size in pixels. */
export interface EncodedCrop {
  dataUrl: string;
  width: number;
  height: number;
}

/**
 * `rect` of the image drawn at most 600 px wide (never scaled up) and encoded as WebP (lossless first, then high
 * quality), or PNG where the browser cannot write WebP: the first that fits in `maxBytes`, else null.
 */
export async function encodeCrop(bitmap: ImageBitmap, rect: Rect, maxBytes: number): Promise<EncodedCrop | null> {
  const size = storedSize(rect);
  const canvas = document.createElement("canvas");
  canvas.width = size.width;
  canvas.height = size.height;
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(bitmap, rect.x, rect.y, rect.width, rect.height, 0, 0, size.width, size.height);
  for (const quality of [1, 0.92, 0.85]) {
    const blob = await toBlob(canvas, "image/webp", quality);
    if (!blob || blob.type !== "image/webp") break;
    if (blob.size <= maxBytes) return { dataUrl: await toDataUrl(blob), ...size };
  }
  const png = await toBlob(canvas, "image/png");
  if (png && png.size <= maxBytes) return { dataUrl: await toDataUrl(png), ...size };
  return null;
}

/** A base64 data URL as a Blob, decoded in memory (no request). */
export function dataUrlBlob(url: string): Blob {
  const comma = url.indexOf(",");
  const type = /^data:([^;,]+)/.exec(url)?.[1] ?? "application/octet-stream";
  const bin = atob(url.slice(comma + 1));
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Blob([bytes], { type });
}

/** The QR text in a stored crop (a data URL), or null when it does not scan. */
export async function decodeDataUrl(url: string): Promise<string | null> {
  try {
    return await decodeQrImage(dataUrlBlob(url));
  } catch {
    return null;
  }
}
