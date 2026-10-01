import { describe, expect, it } from "vitest";
import { autoCropRect, boxOf, clampRect, MIN_CROP, moveRect, type Pixels, resizeRect, snapToCard, storedSize } from "./qr-crop";

const image = { width: 1000, height: 2000 };

describe("QR card crop", () => {
  it("boxes the QR corners, also when the code is slightly rotated", () => {
    expect(
      boxOf([
        { x: 310, y: 820 },
        { x: 690, y: 815 },
        { x: 695, y: 1195 },
        { x: 305, y: 1200 },
      ]),
    ).toEqual({ x: 305, y: 815, width: 390, height: 385 });
  });

  it("fits the first crop around the QR: 1.5 sides wide, 0.9 sides above, a quarter below", () => {
    const qr = { x: 300, y: 800, width: 400, height: 400 };
    expect(autoCropRect(qr, image)).toEqual({ x: 200, y: 440, width: 600, height: 860 });
  });

  it("clamps the first crop to the image near its edges", () => {
    // QR in the top-left corner: nothing above it, the crop starts at 0.
    expect(autoCropRect({ x: 10, y: 20, width: 200, height: 200 }, image)).toEqual({ x: 0, y: 0, width: 260, height: 270 });
    // QR at the bottom-right: the crop ends at the image's edge.
    expect(autoCropRect({ x: 800, y: 1850, width: 180, height: 140 }, image)).toEqual({ x: 755, y: 1688, width: 245, height: 312 });
    // A QR as large as the image: the whole image.
    expect(autoCropRect({ x: 0, y: 0, width: 1000, height: 2000 }, image)).toEqual({ x: 0, y: 0, width: 1000, height: 2000 });
  });

  it("keeps a moved or resized crop inside the image and at least MIN_CROP", () => {
    const r = { x: 100, y: 100, width: 200, height: 300 };
    expect(moveRect(r, -500, 10, image)).toEqual({ x: 0, y: 110, width: 200, height: 300 });
    expect(moveRect(r, 5000, 5000, image)).toEqual({ x: 800, y: 1700, width: 200, height: 300 });
    expect(resizeRect(r, "se", 20, -10, image)).toEqual({ x: 100, y: 100, width: 220, height: 290 });
    expect(resizeRect(r, "nw", -150, -150, image)).toEqual({ x: 0, y: 0, width: 300, height: 400 });
    expect(resizeRect(r, "e", -1000, 0, image)).toEqual({ x: 100, y: 100, width: MIN_CROP, height: 300 });
    expect(resizeRect(r, "n", 0, 1000, image)).toEqual({ x: 100, y: 400 - MIN_CROP, width: 200, height: MIN_CROP });
    expect(resizeRect(r, "s", 0, 5000, image)).toEqual({ x: 100, y: 100, width: 200, height: 1900 });
    expect(clampRect({ x: -5, y: 10.4, width: 3000, height: 4 }, image)).toEqual({ x: 0, y: 10, width: 1000, height: MIN_CROP });
  });

  it("stores at most 600 px wide, never scaled up", () => {
    expect(storedSize({ width: 900, height: 1290 })).toEqual({ width: 600, height: 860 });
    expect(storedSize({ width: 420, height: 500 })).toEqual({ width: 420, height: 500 });
  });

  /** A grey screen with a white card (x 100 to 900, y 300 to 1500), a dark QR at (300, 800, 400, 400) and a name line. */
  function screenshot(card = true): Pixels {
    const px = { width: 1000, height: 2000, data: new Uint8ClampedArray(1000 * 2000 * 4) };
    for (let y = 0; y < px.height; y++) {
      for (let x = 0; x < px.width; x++) {
        const onCard = !card || (x >= 100 && x < 900 && y >= 300 && y < 1500);
        const inQr = x >= 300 && x < 700 && y >= 800 && y < 1200 && (x >> 4) % 2 === (y >> 4) % 2;
        const nameLine = y >= 560 && y < 600 && x >= 380 && x < 620;
        const v = inQr || nameLine ? 20 : onCard ? 255 : 120;
        const i = (y * px.width + x) * 4;
        px.data.set([v, v, onCard ? v : 160, 255], i);
      }
    }
    return px;
  }

  it("snaps the crop to the card's edges when the background changes around it", () => {
    const qr = { x: 300, y: 800, width: 400, height: 400 };
    const auto = autoCropRect(qr, image);
    // The card: 100 to 900 wide, 300 to 1500 tall; the name line inside it is not an edge.
    expect(snapToCard(auto, qr, screenshot())).toEqual({ x: 100, y: 300, width: 800, height: 1200 });
    // A card that fills the screenshot: no change found, the first crop stays.
    expect(snapToCard(auto, qr, screenshot(false))).toEqual(auto);
  });
});
