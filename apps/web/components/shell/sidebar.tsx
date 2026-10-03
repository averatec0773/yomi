"use client";

import { ChevronDownIcon, PanelLeftIcon } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useSyncExternalStore } from "react";
import { useT } from "@/i18n/client";
import { useShortcuts } from "@/lib/shortcuts";
import { cn } from "@/lib/utils";
import { isActive, NAV, openShortcuts, SETTINGS, SIDEBAR_KEY, TOOL_ITEMS, TOOLS_GROUP_KEY } from "./nav";
import { NAV_ICONS, ShortcutsIcon } from "./nav-icons";
import { useLeaderHeld } from "./shell-keys";

const EVENT = "yomi:sidebar";

type Flag = "sidebar" | "tools";

function subscribe(cb: () => void) {
  window.addEventListener(EVENT, cb);
  return () => window.removeEventListener(EVENT, cb);
}

function useHtmlFlag(name: Flag, value: string): boolean {
  return useSyncExternalStore(
    subscribe,
    () => document.documentElement.dataset[name] === value,
    () => false,
  );
}

/** Sets or clears an <html data-*> flag and remembers it in localStorage. */
function setHtmlFlag(name: Flag, key: string, value: string, on: boolean) {
  if (on) document.documentElement.dataset[name] = value;
  else delete document.documentElement.dataset[name];
  try {
    if (on) localStorage.setItem(key, value);
    else localStorage.removeItem(key);
  } catch {
    /* private mode: the state just does not persist */
  }
  window.dispatchEvent(new Event(EVENT));
}

/**
 * The item's second key, only while the leader is held (or just tapped). Drawn with CSS content, so it stays out of the
 * link's text and accessible name; on the icon rail it sits in the item's corner.
 */
function Hint({ k }: { k: string }) {
  const held = useLeaderHeld();
  if (!held || !k) return null;
  return (
    <span
      aria-hidden
      data-hint={k}
      data-testid="nav-key-hint"
      className="inline-flex h-5 min-w-5 shrink-0 items-center justify-center rounded border border-border bg-surface px-1 text-hint text-3 after:content-[attr(data-hint)] rail:absolute rail:top-0 rail:right-0"
    />
  );
}

const focus = "outline-none transition-colors duration-[120ms] focus-visible:ring-2 focus-visible:ring-ring/50";
const item = cn("relative flex h-10 items-center gap-3 rounded-lg px-2.5 text-body rail:justify-center rail:px-0", focus);
const subItem = cn("relative flex h-9 items-center gap-3 rounded-lg pr-2.5 pl-5 text-body rail:h-10 rail:justify-center rail:px-0", focus);
const tone = (active: boolean) => (active ? "bg-primary-soft font-medium text-foreground" : "text-2 hover:bg-tile hover:text-foreground");

/**
 * Desktop navigation (md and up): 232px, collapsible to a 64px icon rail (state in localStorage, applied before paint
 * through html[data-sidebar]). Transactions, Analysis, Assets, then the "Tools" group: a small label linking to /tools and
 * the sub-items Split and settle, Import, Rules (36px, indented). The group's open state is remembered through
 * html[data-tools]; the rail always shows the sub-item icons. Items show their second key only while the leader is held;
 * the active one uses the soft accent. No balances here.
 */
export function Sidebar() {
  const pathname = usePathname();
  const t = useT();
  const collapsed = useHtmlFlag("sidebar", "collapsed");
  const toolsClosed = useHtmlFlag("tools", "closed");
  const keys = useShortcuts();
  // Collapsed-rail tooltip, e.g. "Analysis (\ m)".
  const tip = (label: string, key: string) => (key ? `${label} (${keys.leader} ${key})` : label);
  const SettingsIcon = NAV_ICONS[SETTINGS.href]!;
  const ToolsIcon = NAV_ICONS["/tools"]!;
  const settingsActive = isActive(pathname, [SETTINGS.href]);
  const hubActive = pathname === "/tools";
  // With the group closed, the label stands in for the hidden active sub-item.
  const labelLit = hubActive || (toolsClosed && TOOL_ITEMS.some((n) => isActive(pathname, n.match)));

  return (
    <aside className="sticky top-0 hidden h-screen w-sidebar shrink-0 flex-col gap-1 overflow-y-auto border-r border-border bg-sunken px-3 py-5 md:flex rail:w-sidebar-rail rail:px-2">
      <div className="flex items-center justify-between px-2.5 pt-1 pb-5 rail:justify-center rail:px-0">
        <Link href="/transactions" className="text-[18px] leading-6 font-semibold tracking-[-0.01em] rail:hidden">
          yomi
        </Link>
        <button
          type="button"
          onClick={() => setHtmlFlag("sidebar", SIDEBAR_KEY, "collapsed", !collapsed)}
          aria-label={collapsed ? t.nav.expandSidebar : t.nav.collapseSidebar}
          aria-expanded={!collapsed}
          title={collapsed ? t.nav.expandSidebar : t.nav.collapseSidebar}
          className="inline-flex size-8 items-center justify-center rounded-lg border border-border text-2 transition-colors duration-[120ms] hover:text-foreground"
        >
          <PanelLeftIcon className="size-4" aria-hidden />
        </button>
      </div>

      <nav aria-label={t.nav.main} className="flex flex-col gap-1">
        {NAV.slice(0, 3).map((n) => {
          const Icon = NAV_ICONS[n.href]!;
          const active = isActive(pathname, n.match);
          return (
            <Link
              key={n.href}
              href={n.href}
              aria-current={active ? "page" : undefined}
              title={collapsed ? tip(t.nav[n.label], keys[n.action]) : undefined}
              className={cn(item, tone(active))}
            >
              <Icon className="size-[18px] shrink-0" aria-hidden />
              <span className="flex-1 truncate rail:sr-only">{t.nav[n.label]}</span>
              <Hint k={keys[n.action]} />
            </Link>
          );
        })}

        <div className="mt-4 flex items-center gap-1 rail:mt-2 rail:border-t rail:border-border rail:pt-2">
          <Link
            href="/tools"
            aria-current={hubActive ? "page" : undefined}
            title={collapsed ? tip(t.nav.tools, keys.goTools) : undefined}
            className={cn(
              "relative flex h-8 flex-1 items-center gap-3 rounded-lg px-2.5 text-meta font-medium rail:h-10 rail:justify-center rail:px-0",
              focus,
              labelLit ? "bg-primary-soft text-foreground" : "text-3 hover:bg-tile hover:text-foreground rail:text-2",
            )}
          >
            <ToolsIcon className="hidden size-[18px] shrink-0 rail:block" aria-hidden />
            <span className="flex-1 truncate rail:sr-only">{t.nav.tools}</span>
            <Hint k={keys.goTools} />
          </Link>
          <button
            type="button"
            onClick={() => setHtmlFlag("tools", TOOLS_GROUP_KEY, "closed", !toolsClosed)}
            aria-expanded={!toolsClosed}
            aria-controls="sidebar-tool-items"
            aria-label={toolsClosed ? t.nav.showTools : t.nav.hideTools}
            title={toolsClosed ? t.nav.showTools : t.nav.hideTools}
            className={cn("inline-flex size-8 shrink-0 items-center justify-center rounded-lg text-3 hover:bg-tile hover:text-foreground rail:hidden", focus)}
          >
            <ChevronDownIcon className="size-4 transition-transform duration-[120ms] tools-closed:-rotate-90" aria-hidden />
          </button>
        </div>
        <div id="sidebar-tool-items" className="flex flex-col gap-0.5 tools-closed:hidden">
          {TOOL_ITEMS.map((n) => {
            const Icon = NAV_ICONS[n.href]!;
            const active = isActive(pathname, n.match);
            const label = t.nav.toolItems[n.label];
            return (
              <Link
                key={n.href}
                href={n.href}
                aria-current={active ? "page" : undefined}
                title={collapsed ? tip(label, keys[n.action]) : undefined}
                className={cn(subItem, tone(active))}
              >
                <Icon className="size-[18px] shrink-0" aria-hidden />
                <span className="flex-1 truncate rail:sr-only">{label}</span>
                <Hint k={keys[n.action]} />
              </Link>
            );
          })}
        </div>
      </nav>

      <div className="flex-1" />

      <Link
        href={SETTINGS.href}
        aria-current={settingsActive ? "page" : undefined}
        title={collapsed ? tip(t.nav.settings, keys[SETTINGS.action]) : undefined}
        className={cn(item, tone(settingsActive))}
      >
        <SettingsIcon className="size-[18px] shrink-0" aria-hidden />
        <span className="flex-1 truncate rail:sr-only">{t.nav.settings}</span>
        <Hint k={keys[SETTINGS.action]} />
      </Link>
      <button
        type="button"
        onClick={openShortcuts}
        title={collapsed ? (keys.help ? `${t.nav.shortcuts} (${keys.help})` : t.nav.shortcuts) : undefined}
        className={cn(item, "text-left text-2 hover:bg-tile hover:text-foreground")}
      >
        <ShortcutsIcon className="size-[18px] shrink-0" aria-hidden />
        <span className="flex-1 truncate rail:sr-only">{t.nav.shortcuts}</span>
      </button>
    </aside>
  );
}
