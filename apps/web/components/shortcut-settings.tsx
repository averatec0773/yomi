"use client";

import {
  isClearable,
  mergeShortcuts,
  type ShortcutAction,
  type ShortcutBindings,
  shortcutOverrides,
  shortcutProblems,
  type ShortcutsSetting,
} from "@yomi/contracts/shortcuts";
import { RotateCcwIcon } from "lucide-react";
import { type KeyboardEvent, useState } from "react";
import { toast } from "sonner";
import { useIsMac } from "@/components/shell/shortcuts-sheet";
import { Button } from "@/components/ui-kit/button";
import { ListCard } from "@/components/ui-kit/list-card";
import { fmt } from "@/i18n";
import { useT } from "@/i18n/client";
import { apiFetch } from "@/lib/api";
import { keyFromEvent } from "@/lib/shortcut-keys";
import { useShortcutOverrides } from "@/lib/shortcuts";
import { cn } from "@/lib/utils";

type Row = { action: ShortcutAction } | { fixed: "add" | "close"; keys: string[] };

const GROUPS: { group: "nav" | "anywhere" | "list"; rows: (mac: boolean) => Row[] }[] = [
  {
    group: "nav",
    rows: () =>
      (["leader", "goTransactions", "goStats", "goAssets", "goTools", "goSplit", "goImport", "goRules", "goSettings"] as const).map((action) => ({
        action,
      })),
  },
  {
    group: "anywhere",
    rows: (mac) => [{ fixed: "add", keys: [mac ? "⌘" : "Ctrl", "K"] }, { action: "search" }, { action: "help" }],
  },
  {
    group: "list",
    rows: () => [
      ...(["listNext", "listPrev", "listSelect", "listSplit", "listSplitAlt", "listCategory", "listNote"] as const).map((action) => ({ action })),
      { fixed: "close", keys: ["Esc"] },
    ],
  },
];

const MODIFIERS = new Set(["Shift", "Control", "Alt", "AltGraph", "Meta", "CapsLock", "Fn", "OS"]);

function Kbd({ children, muted }: { children: string; muted?: boolean }) {
  return (
    <kbd
      className={cn(
        "inline-flex h-6 min-w-6 items-center justify-center rounded-md border border-border bg-sunken px-1.5 font-sans text-hint",
        muted ? "text-3" : "text-2",
      )}
    >
      {children}
    </kbd>
  );
}

/**
 * Settings > Keyboard shortcuts: one row per binding with a key capture button ("Press a key"; Esc cancels, Backspace
 * clears where allowed). A valid change saves at once (PUT /api/settings/shortcuts, overrides only) and applies to every
 * hint and handler through the shortcuts provider; a clash in one scope is shown on both rows and not saved until fixed.
 * ⌘K and Esc are fixed.
 */
export function ShortcutSettings() {
  const t = useT();
  const s = t.settings.keys;
  const mac = useIsMac();
  const { overrides, setOverrides } = useShortcutOverrides();
  const [draft, setDraft] = useState<ShortcutBindings>(() => mergeShortcuts(overrides));
  const [capturing, setCapturing] = useState<ShortcutAction | null>(null);
  const [unusable, setUnusable] = useState<ShortcutAction | null>(null);
  const [saving, setSaving] = useState(false);
  const problems = shortcutProblems(draft);
  const isDefault = Object.keys(shortcutOverrides(draft)).length === 0;

  async function save(next: ShortcutBindings) {
    setSaving(true);
    try {
      const r = await apiFetch<ShortcutsSetting>("/settings/shortcuts", { method: "PUT", json: { overrides: shortcutOverrides(next) } });
      setOverrides(r.overrides);
      return true;
    } catch {
      // apiFetch already showed the error.
      return false;
    } finally {
      setSaving(false);
    }
  }

  function apply(action: ShortcutAction, key: string) {
    setCapturing(null);
    setUnusable(null);
    if (draft[action] === key) return;
    const next = { ...draft, [action]: key };
    setDraft(next);
    if (Object.keys(shortcutProblems(next)).length === 0) void save(next);
  }

  async function reset() {
    setCapturing(null);
    setUnusable(null);
    const defaults = mergeShortcuts({});
    if (await save(defaults)) {
      setDraft(defaults);
      toast.success(s.resetDone);
    }
  }

  function onCaptureKey(action: ShortcutAction, e: KeyboardEvent<HTMLButtonElement>) {
    if (capturing !== action) return;
    e.preventDefault();
    e.stopPropagation();
    if (e.key === "Escape") {
      setCapturing(null);
      return;
    }
    if (e.key === "Backspace" || e.key === "Delete") {
      if (isClearable(action)) apply(action, "");
      return;
    }
    if (MODIFIERS.has(e.key)) return;
    const key = keyFromEvent(e.nativeEvent);
    if (key === null) {
      setCapturing(null);
      setUnusable(action);
      return;
    }
    apply(action, key);
  }

  const label = (a: ShortcutAction) => s.actions[a];

  function message(action: ShortcutAction): string | null {
    if (unusable === action) return s.unusable;
    const p = problems[action];
    if (!p) return null;
    if (p.code === "conflict") return `${fmt(s.conflict, { action: label(p.with) })} ${s.unsaved}`;
    if (p.code === "required") return s.required;
    return s.unusable;
  }

  function actionRow(action: ShortcutAction) {
    const key = draft[action];
    const active = capturing === action;
    const error = message(action);
    const hintId = `shortcut-${action}-hint`;
    const help = active ? (isClearable(action) ? s.captureHint : s.captureHintRequired) : action === "leader" ? s.leaderHint : null;
    return (
      <li key={action} data-testid={`shortcut-${action}`} className="flex flex-col gap-1 px-4 py-2.5 md:px-5">
        <div className="flex min-h-9 items-center justify-between gap-3">
          <span className="min-w-0 text-body">{label(action)}</span>
          <span className="flex shrink-0 items-center gap-1.5">
            {action.startsWith("go") && draft.leader && <Kbd muted>{draft.leader}</Kbd>}
            <button
              type="button"
              aria-label={fmt(s.change, { action: label(action) })}
              aria-describedby={error || help ? hintId : undefined}
              aria-invalid={error ? true : undefined}
              data-capturing={active || undefined}
              disabled={saving}
              onClick={() => {
                setUnusable(null);
                setCapturing(active ? null : action);
              }}
              onKeyDown={(e) => onCaptureKey(action, e)}
              onBlur={() => active && setCapturing(null)}
              className={cn(
                "hit relative inline-flex h-8 min-w-16 items-center justify-center rounded-lg border px-2.5 text-meta outline-none transition-colors duration-[120ms] focus-visible:ring-2 focus-visible:ring-ring/50 disabled:opacity-60",
                active ? "border-primary bg-primary-soft text-foreground" : error ? "border-foreground/40 bg-surface" : "border-border bg-surface hover:bg-sunken",
              )}
            >
              {active ? s.press : key ? <Kbd>{key}</Kbd> : <span className="text-3">{s.notSet}</span>}
            </button>
          </span>
        </div>
        {(error || help) && (
          <p id={hintId} role={error ? "alert" : undefined} className={cn("text-meta", error ? "text-foreground" : "text-2")}>
            {error ?? help}
          </p>
        )}
      </li>
    );
  }

  return (
    <div className="flex flex-col gap-5">
      {GROUPS.map((g) => (
        <div key={g.group} className="flex flex-col gap-2">
          <h3 className="text-body font-medium">{s.groups[g.group]}</h3>
          <ListCard>
            <ul className="divide-y divide-line-soft">
              {g.rows(mac).map((row) =>
                "action" in row ? (
                  actionRow(row.action)
                ) : (
                  <li key={row.fixed} className="flex min-h-12 items-center justify-between gap-3 px-4 py-2.5 md:px-5">
                    <span className="min-w-0 text-body">{s.fixed[row.fixed]}</span>
                    <span className="flex shrink-0 items-center gap-1.5">
                      <span className="text-meta text-3">{s.fixedLabel}</span>
                      {row.keys.map((k) => (
                        <Kbd key={k} muted>
                          {k}
                        </Kbd>
                      ))}
                    </span>
                  </li>
                ),
              )}
            </ul>
          </ListCard>
        </div>
      ))}
      <div>
        <Button onClick={() => void reset()} disabled={saving || isDefault}>
          <RotateCcwIcon aria-hidden />
          {s.reset}
        </Button>
      </div>
    </div>
  );
}
