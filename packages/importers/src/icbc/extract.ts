import { getDocument, Util } from "pdfjs-dist/legacy/build/pdf.mjs";
import type { TextItem } from "./parse";

/** Reads every text item of every page, positioned in display coordinates (origin top-left, y down, page rotation applied). */
export async function extractItems(bytes: Uint8Array): Promise<TextItem[][]> {
  const task = getDocument({
    data: bytes.slice(),
    disableFontFace: true,
    useSystemFonts: false,
    verbosity: 0,
  });
  try {
    const doc = await task.promise;
    const pages: TextItem[][] = [];
    for (let n = 1; n <= doc.numPages; n++) {
      const page = await doc.getPage(n);
      const viewport = page.getViewport({ scale: 1 });
      const content = await page.getTextContent();
      const items: TextItem[] = [];
      for (const it of content.items) {
        if (!("str" in it) || it.str.trim() === "") continue;
        const m = Util.transform(viewport.transform, it.transform) as number[];
        const [a = 0, b = 0, , , e = 0, f = 0] = m;
        items.push({
          str: it.str,
          x: round(e),
          y: round(f),
          w: round(it.width),
          size: round(Math.hypot(a, b)),
          angle: round((Math.atan2(b, a) * 180) / Math.PI),
        });
      }
      pages.push(items);
    }
    return pages;
  } finally {
    await task.destroy();
  }
}

function round(v: number): number {
  return Math.round(v * 100) / 100;
}
