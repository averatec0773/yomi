"use client";

import { KeyboardIcon } from "lucide-react";
import { useEffect, useState, useSyncExternalStore } from "react";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { useT } from "@/i18n/client";
import type { ShortcutBindings } from "@yomi/contracts/shortcuts";
import Link from "next/link";
import { fmt } from "@/i18n";
import type { Dictionary } from "@/i18n/en";
import { useShortcuts } from "@/lib/shortcuts";
import { SHORTCUTS_EVENT } from "./nav";

type Item = keyof Dictionary["shortcuts"]["items"];

const noop = () => () => {};

/** True on Apple platforms (⌘ instead of Ctrl). */
export function useIsMac(): boolean {
  return useSyncExternalStore(
    noop,
    () => /Mac|iPhone|iPad/.test(navigator.userAgent),
    () => true,
  );
}

/** Every shortcut with the user's current keys, by group. Keys are not translated; unset keys drop out. */
function groups(mac: boolean, k: ShortcutBindings): { group: keyof Dictionary["shortcuts"]["groups"]; rows: [Item, string[][]][] }[] {
  const mod = mac ? "⌘" : "Ctrl";
  const one = (...keys: string[]) => keys.filter(Boolean).map((key) => [key]);
  const go = (key: string) => (key ? [[k.leader, key]] : []);
  return [
    {
      group: "go",
      rows: [
        ["transactions", go(k.goTransactions)],
        ["analysis", go(k.goStats)],
        ["assets", go(k.goAssets)],
        ["tools", go(k.goTools)],
        ["settings", go(k.goSettings)],
        ["split", go(k.goSplit)],
        ["import", go(k.goImport)],
        ["rules", go(k.goRules)],
      ],
    },
    {
      group: "anywhere",
      rows: [
        ["add", [[mod, "K"]]],
        ["search", one(k.search)],
        ["shortcuts", one(k.help)],
      ],
    },
    {
      group: "list",
      rows: [
        ["move", one(k.listNext, k.listPrev)],
        ["select", one(k.listSelect)],
        ["selectRange", k.listSelect ? [["Shift", k.listSelect]] : []],
        ["openSplit", one(k.listSplit, k.listSplitAlt)],
        ["category", one(k.listCategory)],
        ["note", one(k.listNote)],
        ["clear", [["Esc"]]],
      ],
    },
    {
      group: "split",
      rows: [
        ["pick", [["1–9"]]],
        ["close", [["Esc"]]],
      ],
    },
  ];
}

function Keys({ combos }: { combos: string[][] }) {
  return (
    <span className="flex shrink-0 items-center gap-1.5">
      {combos.map((combo, i) => (
        <span key={i} className="flex items-center gap-1">
          {i > 0 && <span className="text-hint text-3">/</span>}
          {combo.map((k, j) => (
            <kbd key={j} className="inline-flex h-6 min-w-6 items-center justify-center rounded-md border border-border bg-sunken px-1.5 text-hint text-2">
              {k}
            </kbd>
          ))}
        </span>
      ))}
    </span>
  );
}

/** The "?" sheet: every keyboard shortcut in one place. Mounted once in the root layout; open with openShortcuts(). */
export function ShortcutsSheet() {
  const t = useT();
  const s = t.shortcuts;
  const mac = useIsMac();
  const keys = useShortcuts();
  const [open, setOpen] = useState(false);

  useEffect(() => {
    const onOpen = () => setOpen(true);
    window.addEventListener(SHORTCUTS_EVENT, onOpen);
    return () => window.removeEventListener(SHORTCUTS_EVENT, onOpen);
  }, []);

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent className="max-h-[85vh] gap-0 overflow-y-auto rounded-2xl bg-raised p-6 text-body shadow-dialog ring-1 ring-border sm:max-w-lg">
        <DialogTitle className="flex items-center gap-2.5 pr-8 text-title font-semibold">
          <KeyboardIcon className="size-[18px] text-2" aria-hidden />
          {s.title}
        </DialogTitle>
        <DialogDescription className="mt-1 text-meta text-2">
          {fmt(s.description, { leader: keys.leader })}{" "}
          <Link href="/settings?tab=shortcuts" onClick={() => setOpen(false)} className="text-primary underline-offset-2 hover:underline">
            {s.change}
          </Link>
        </DialogDescription>
        <div className="mt-5 grid gap-6 sm:grid-cols-2">
          {groups(mac, keys).map((g) => (
            <section key={g.group} aria-label={s.groups[g.group]}>
              <h3 className="mb-1.5 text-meta font-medium text-2">{s.groups[g.group]}</h3>
              <ul>
                {g.rows.map(([label, combos]) => (
                  <li key={label} className="flex h-9 items-center justify-between gap-3 border-b border-line-soft last:border-b-0">
                    <span className="truncate">{s.items[label]}</span>
                    {combos.length ? <Keys combos={combos} /> : <span className="text-hint text-3">{s.notSet}</span>}
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>
      </DialogContent>
    </Dialog>
  );
}
