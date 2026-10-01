"use client";

import { useSyncExternalStore } from "react";

const QUERY = "(min-width: 768px)";

function subscribe(cb: () => void) {
  const mq = window.matchMedia(QUERY);
  mq.addEventListener("change", cb);
  return () => mq.removeEventListener("change", cb);
}

/** True at the md breakpoint and up (the sidebar layout). The server renders the desktop version. */
export function useIsDesktop(): boolean {
  return useSyncExternalStore(
    subscribe,
    () => window.matchMedia(QUERY).matches,
    () => true,
  );
}
