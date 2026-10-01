"use client";

import { useSearchParams } from "next/navigation";
import { useEffect, useRef, type KeyboardEvent, type ReactNode } from "react";
import { useT } from "@/i18n/client";
import { cn } from "@/lib/utils";

const SETTINGS_TABS = ["general", "profile", "appearance", "shortcuts", "connections", "security", "data"] as const;
export type SettingsTab = (typeof SETTINGS_TABS)[number];

/** The tab in the URL (`?tab=`), general when missing or unknown. */
function useActiveTab(): SettingsTab {
  const value = useSearchParams().get("tab");
  return SETTINGS_TABS.find((t) => t === value) ?? "general";
}

const tabDomId = (id: SettingsTab) => `settings-tab-${id}`;

/**
 * Settings (/settings): the tab bar under the page header, one tab per module; `SettingsPanel` shows the matching
 * section. The URL is the state (`?tab=<id>`, default general): the server renders the right panel, a click pushes a
 * history entry without a server round trip (back and forward switch tabs), arrows move between tabs (roving
 * tabindex). A hash that points into another panel (legacy `/settings#backup`) opens that panel; `AnchorFlash` then
 * scrolls to it. Sticky from md; on phones the bar scrolls sideways and keeps the active tab in view.
 */
export function SettingsTabs({ icons }: { icons: Record<SettingsTab, ReactNode> }) {
  const t = useT().settings.tabs;
  const active = useActiveTab();
  const barRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const follow = () => {
      const id = decodeURIComponent(window.location.hash.slice(1));
      const panel = id ? document.getElementById(id)?.closest<HTMLElement>('[role="tabpanel"]') : null;
      if (panel?.hidden) window.history.replaceState(null, "", `?tab=${panel.id}${window.location.hash}`);
    };
    // After the router's own mount effects, which would otherwise put the original URL back.
    const timer = setTimeout(follow);
    window.addEventListener("hashchange", follow);
    return () => {
      clearTimeout(timer);
      window.removeEventListener("hashchange", follow);
    };
  }, []);

  // Keep the active tab inside the sideways-scrolling bar (phones) without scrolling the page.
  useEffect(() => {
    const list = listRef.current;
    const tab = document.getElementById(tabDomId(active));
    if (!list || !tab) return;
    const left = tab.offsetLeft;
    if (left < list.scrollLeft || left + tab.offsetWidth > list.scrollLeft + list.clientWidth) {
      list.scrollTo({ left: left - (list.clientWidth - tab.offsetWidth) / 2 });
    }
  }, [active]);

  function select(id: SettingsTab, history: "push" | "replace") {
    if (id === active) return;
    // With the bar stuck to the top and the page scrolled into a long panel, the next one starts right under the bar.
    const bar = barRef.current;
    const panel = document.getElementById(active);
    if (bar?.parentElement && panel) {
      const gap = parseFloat(getComputedStyle(bar.parentElement).rowGap) || 0;
      const past = panel.getBoundingClientRect().top - bar.getBoundingClientRect().bottom - gap;
      if (past < 0) window.scrollBy({ top: past });
    }
    if (history === "push") window.history.pushState(null, "", `?tab=${id}`);
    else window.history.replaceState(null, "", `?tab=${id}`);
  }

  function onKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    const i = SETTINGS_TABS.indexOf(active);
    const n = SETTINGS_TABS.length;
    const next =
      e.key === "ArrowRight" ? SETTINGS_TABS[(i + 1) % n]
      : e.key === "ArrowLeft" ? SETTINGS_TABS[(i - 1 + n) % n]
      : e.key === "Home" ? SETTINGS_TABS[0]
      : e.key === "End" ? SETTINGS_TABS[n - 1]
      : undefined;
    if (!next) return;
    e.preventDefault();
    select(next, "replace");
    document.getElementById(tabDomId(next))?.focus();
  }

  return (
    <div ref={barRef} className="-mx-gutter bg-background md:sticky md:top-0 md:z-20 md:mx-0">
      <div
        ref={listRef}
        role="tablist"
        aria-label={t.label}
        onKeyDown={onKeyDown}
        className="relative flex gap-1 overflow-x-auto border-b border-border px-gutter py-1.5 [scrollbar-width:none] md:px-0 md:py-2 [&::-webkit-scrollbar]:hidden"
      >
        {SETTINGS_TABS.map((id) => {
          const on = id === active;
          return (
            <button
              key={id}
              id={tabDomId(id)}
              type="button"
              role="tab"
              aria-selected={on}
              aria-controls={id}
              tabIndex={on ? 0 : -1}
              onClick={() => select(id, "push")}
              className={cn(
                "flex h-11 shrink-0 items-center gap-2 rounded-lg px-3 text-body font-medium whitespace-nowrap outline-none transition-colors duration-[120ms] focus-visible:ring-2 focus-visible:ring-ring/50 md:h-9 [&_svg]:size-4",
                on ? "bg-primary-soft text-foreground" : "text-2 hover:bg-tile hover:text-foreground",
              )}
            >
              {icons[id]}
              {t[id]}
            </button>
          );
        })}
      </div>
    </div>
  );
}

/** One Settings module as a tab panel: shown only while its tab is active (hidden panels stay in the DOM for anchors). */
export function SettingsPanel({ id, className, children }: { id: SettingsTab; className?: string; children: ReactNode }) {
  const active = useActiveTab();
  return (
    <section id={id} role="tabpanel" aria-labelledby={tabDomId(id)} hidden={id !== active} data-anchor className={className}>
      {children}
    </section>
  );
}
