"use client";

import type { TimeZoneChange } from "@yomi/contracts";
import { timeZoneNames } from "@yomi/core/time";
import { CheckIcon, ChevronsUpDownIcon, GlobeIcon } from "lucide-react";
import { useRouter } from "next/navigation";
import { useMemo, useState, useTransition } from "react";
import { toast } from "sonner";
import { Command, CommandEmpty, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { fmt, plural } from "@/i18n";
import { useT } from "@/i18n/client";
import { apiFetch } from "@/lib/api";
import { useTimeZone } from "@/lib/time-zone";
import { cn } from "@/lib/utils";

/** Settings > General: searchable list of IANA zones; picking one regroups every transaction by it. */
export function TimeZonePicker() {
  const t = useT();
  const s = t.settings;
  const router = useRouter();
  const current = useTimeZone();
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [pending, startTransition] = useTransition();
  const zones = useMemo(() => [...new Set([current, ...timeZoneNames()])].sort(), [current]);

  const choose = async (zone: string) => {
    setOpen(false);
    if (zone === current) return;
    setSaving(true);
    try {
      const r = await apiFetch<TimeZoneChange>("/settings/time-zone", { method: "PUT", json: { timeZone: zone } });
      toast.success(r.changed > 0 ? plural(s.timeZoneMoved, r.changed, { zone: r.timeZone }) : fmt(s.timeZoneSaved, { zone: r.timeZone }));
      startTransition(() => router.refresh());
    } catch {
      // apiFetch already showed the error.
    } finally {
      setSaving(false);
    }
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label={s.timeZone}
          data-testid="time-zone-picker"
          disabled={saving || pending}
          className={cn(
            "hit relative inline-flex h-10 w-full max-w-xs items-center gap-2 self-start rounded-lg border border-border bg-surface px-3 text-body outline-none hover:bg-sunken focus-visible:ring-2 focus-visible:ring-ring/50",
            (saving || pending) && "opacity-60",
          )}
        >
          <GlobeIcon className="size-4 shrink-0 text-2" aria-hidden />
          <span className="min-w-0 flex-1 truncate text-left">{current}</span>
          <ChevronsUpDownIcon className="size-4 shrink-0 text-2" aria-hidden />
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-72 p-0">
        <Command>
          <CommandInput placeholder={s.timeZoneSearch} />
          <CommandList>
            <CommandEmpty>{s.timeZoneEmpty}</CommandEmpty>
            {zones.map((z) => (
              <CommandItem key={z} value={z} onSelect={() => void choose(z)}>
                <span className="flex-1 truncate">{z}</span>
                {z === current && <CheckIcon className="size-4" aria-hidden />}
              </CommandItem>
            ))}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
