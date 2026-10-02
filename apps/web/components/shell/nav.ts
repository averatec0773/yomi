import type { ShortcutAction } from "@yomi/contracts/shortcuts";

/**
 * Main navigation (sidebar, phone tabs). `label` is a `nav` dictionary key; `action` names its leader shortcut (the key
 * comes from `useShortcuts()`). `match`: path prefixes that light the item (on phones Tools owns /split and /import too).
 */
export const NAV = [
  { href: "/transactions", label: "transactions", action: "goTransactions", match: ["/transactions"] },
  { href: "/analysis", label: "analysis", action: "goStats", match: ["/analysis"] },
  { href: "/assets", label: "assets", action: "goAssets", match: ["/assets"] },
  { href: "/tools", label: "tools", action: "goTools", match: ["/tools", "/split", "/import"] },
] as const;

/** The sidebar's "Tools" group (desktop): the label links to /tools, these sub-items follow. `label` is a `nav.toolItems` key. */
export const TOOL_ITEMS = [
  { href: "/split", label: "split", action: "goSplit", match: ["/split"] },
  { href: "/import", label: "import", action: "goImport", match: ["/import"] },
  { href: "/tools/rules", label: "rules", action: "goRules", match: ["/tools/rules"] },
] as const;

/** Settings, at the bottom of the sidebar (and a row under Tools on phones). */
export const SETTINGS = { href: "/settings", action: "goSettings" } as const;

/** Leader shortcuts (the leader, then the action's key): every destination above. */
export const NAV_KEYS: readonly { action: ShortcutAction; href: string }[] = [...NAV, ...TOOL_ITEMS, SETTINGS];

export function isActive(pathname: string, match: readonly string[]): boolean {
  return match.some((m) => pathname === m || pathname.startsWith(`${m}/`));
}

/** Opens the shortcuts sheet from anywhere on the client (the "?" key, the sidebar, the Tools hub on phones). */
export const SHORTCUTS_EVENT = "yomi:shortcuts";

export function openShortcuts(): void {
  window.dispatchEvent(new CustomEvent(SHORTCUTS_EVENT));
}

/** localStorage key and <html data-sidebar> value for the collapsed sidebar. */
export const SIDEBAR_KEY = "yomi.sidebar";

/** localStorage key and <html data-tools> value for the closed Tools group in the sidebar (open by default). */
export const TOOLS_GROUP_KEY = "yomi.sidebar.tools";

/** Runs before paint (inline in <head>) so a collapsed sidebar or a closed Tools group does not flash open. */
export const SIDEBAR_BOOT = `try{var s=localStorage,d=document.documentElement.dataset;if(s.getItem("${SIDEBAR_KEY}")==="collapsed")d.sidebar="collapsed";if(s.getItem("${TOOLS_GROUP_KEY}")==="closed")d.tools="closed"}catch(e){}`;
