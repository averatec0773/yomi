"use client";

import { PlusIcon } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useT } from "@/i18n/client";
import { openQuickAdd } from "@/lib/quick-add";
import { cn } from "@/lib/utils";
import { isActive, NAV } from "./nav";
import { NAV_ICONS } from "./nav-icons";

/**
 * Phone navigation (below md): the four tabs with Add in the middle of the bar, so it never covers a row's amount or a
 * page button. Add is the filled primary on phones (page primaries turn soft there). It steps aside while a selection
 * bar is up (`bulk:`). Settings and Shortcuts live under Tools on phones.
 */
export function BottomTabs() {
  const pathname = usePathname();
  const t = useT();
  const tab = (n: (typeof NAV)[number]) => {
    const Icon = NAV_ICONS[n.href]!;
    const active = isActive(pathname, n.match);
    return (
      <Link
        key={n.href}
        href={n.href}
        aria-current={active ? "page" : undefined}
        className={cn(
          "flex min-h-14 flex-col items-center justify-center gap-1 rounded-lg outline-none focus-visible:ring-2 focus-visible:ring-ring/50",
          active ? "text-primary" : "text-2",
        )}
      >
        <Icon className="size-[22px]" aria-hidden />
        <span className="text-[11px] leading-[14px]">{t.nav[n.label]}</span>
      </Link>
    );
  };
  return (
    <nav
      aria-label={t.nav.main}
      className="fixed inset-x-0 bottom-0 z-40 grid grid-cols-5 items-center border-t border-border bg-sunken px-2 pt-2 pb-[calc(8px+env(safe-area-inset-bottom))] md:hidden"
    >
      {NAV.slice(0, 2).map(tab)}
      <div className="flex justify-center">
        <button
          type="button"
          onClick={() => openQuickAdd()}
          aria-label={t.nav.addTransaction}
          className="inline-flex size-12 items-center justify-center rounded-full bg-primary text-primary-foreground shadow-dialog transition-transform duration-[120ms] outline-none focus-visible:ring-2 focus-visible:ring-ring/50 active:scale-95 bulk:invisible"
        >
          <PlusIcon className="size-6" aria-hidden />
        </button>
      </div>
      {NAV.slice(2).map(tab)}
    </nav>
  );
}
