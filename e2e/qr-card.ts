import type { Page } from "@playwright/test";
import QRCode from "qrcode";

/**
 * A fictional "bank app" QR card screenshot, drawn in the page's canvas at test time: a 1080 x 1600 screen in a muted
 * color, a white card (x 90 to 990, y 240 to 1440) with the name "Alex Demo" and the word "Zelle" as plain text
 * (no logo), and a QR code of `payload` (560 px, x 260 to 820, y 600 to 1160). Never a real person's or bank's QR.
 */
export const CARD = { width: 1080, height: 1600, card: { x: 90, y: 240, width: 900, height: 1200 }, qr: { x: 260, y: 600, side: 560 } };

export async function qrCardPng(page: Page, payload: string): Promise<Buffer> {
  const { modules } = QRCode.create(payload, { errorCorrectionLevel: "M" });
  const dark: number[] = [];
  for (let y = 0; y < modules.size; y++) for (let x = 0; x < modules.size; x++) if (modules.get(y, x)) dark.push(y * modules.size + x);
  const dataUrl = await page.evaluate(
    ({ size, dark, c }) => {
      const canvas = document.createElement("canvas");
      canvas.width = c.width;
      canvas.height = c.height;
      const ctx = canvas.getContext("2d")!;
      ctx.fillStyle = "#5b5670";
      ctx.fillRect(0, 0, c.width, c.height);
      ctx.fillStyle = "#ffffff";
      ctx.beginPath();
      ctx.roundRect(c.card.x, c.card.y, c.card.width, c.card.height, 36);
      ctx.fill();
      ctx.fillStyle = "#1d1c1a";
      ctx.textAlign = "center";
      ctx.font = "600 64px sans-serif";
      ctx.fillText("Alex Demo", c.width / 2, 380);
      ctx.fillStyle = "#4a4a4a";
      ctx.font = "500 52px sans-serif";
      ctx.fillText("Zelle", c.width / 2, 470);
      // Whole-pixel modules, centered in the QR's square.
      const unit = Math.floor(c.qr.side / size);
      const off = Math.floor((c.qr.side - unit * size) / 2);
      ctx.fillStyle = "#000000";
      for (const i of dark) ctx.fillRect(c.qr.x + off + (i % size) * unit, c.qr.y + off + Math.floor(i / size) * unit, unit, unit);
      return canvas.toDataURL("image/png");
    },
    { size: modules.size, dark, c: CARD },
  );
  return Buffer.from(dataUrl.split(",")[1]!, "base64");
}

/** The card alone as the dialog stores it ("Original"): cropped to the card, 600 px wide, lossless WebP. */
export async function qrCardOriginal(page: Page, payload: string): Promise<{ dataUrl: string; width: number; height: number }> {
  const png = `data:image/png;base64,${(await qrCardPng(page, payload)).toString("base64")}`;
  return page.evaluate(
    async ({ png, card }) => {
      const img = new Image();
      img.src = png;
      await img.decode();
      const width = 600;
      const height = Math.round((card.height * width) / card.width);
      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext("2d")!;
      ctx.imageSmoothingQuality = "high";
      ctx.drawImage(img, card.x, card.y, card.width, card.height, 0, 0, width, height);
      return { dataUrl: canvas.toDataURL("image/webp", 1), width, height };
    },
    { png, card: CARD.card },
  );
}
