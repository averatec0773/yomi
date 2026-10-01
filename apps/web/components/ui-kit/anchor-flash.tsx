"use client";

import { useEffect } from "react";

const FLASH_MS = 1400;
/** How long to wait for a target that is not laid out yet (inside a Settings tab panel that is about to open). */
const WAIT_MS = 3000;

/**
 * Deep links (/settings?tab=data#backup, /import#bank): scrolls the `[data-anchor]` element named by the URL hash into
 * view and tints it briefly (`[data-flash]`, styled in globals.css). Runs on mount and on hash changes; a target in a
 * hidden panel is retried every frame (up to 3 s) while its tab opens. Renders nothing.
 */
export function AnchorFlash() {
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let frame = 0;
    let el: HTMLElement | null = null;
    const flash = (since: number) => {
      const id = decodeURIComponent(window.location.hash.slice(1));
      if (!id) return;
      const target = document.getElementById(id);
      if (!target?.hasAttribute("data-anchor")) return;
      if (target.getClientRects().length === 0) {
        if (performance.now() - since < WAIT_MS) frame = requestAnimationFrame(() => flash(since));
        return;
      }
      if (timer) clearTimeout(timer);
      el?.removeAttribute("data-flash");
      el = target;
      target.scrollIntoView({ block: "start" });
      target.setAttribute("data-flash", "");
      timer = setTimeout(() => target.removeAttribute("data-flash"), FLASH_MS);
    };
    const start = () => {
      cancelAnimationFrame(frame);
      // After Next has painted and done its own hash scroll (and a Settings tab has opened).
      const since = performance.now();
      frame = requestAnimationFrame(() => flash(since));
    };
    start();
    window.addEventListener("hashchange", start);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener("hashchange", start);
      if (timer) clearTimeout(timer);
      el?.removeAttribute("data-flash");
    };
  }, []);
  return null;
}
