"use client";

import type { Theme, ThemeSetting } from "@yomi/contracts";
import { MonitorIcon, MoonIcon, SunIcon, type LucideIcon } from "lucide-react";
import { Segmented } from "@/components/ui-kit/segmented";
import { useT } from "@/i18n/client";
import { apiFetch } from "@/lib/api";
import { useTheme } from "@/lib/theme";

const OPTIONS: { value: Theme; icon: LucideIcon }[] = [
  { value: "system", icon: MonitorIcon },
  { value: "light", icon: SunIcon },
  { value: "dark", icon: MoonIcon },
];

/** Settings > Appearance: System / Light / Dark. Applies at once, then saves; a failed save puts the old theme back. */
export function AppearanceSettings() {
  const a = useT().settings.appearance;
  const { theme, setTheme } = useTheme();

  const choose = async (next: Theme) => {
    if (next === theme) return;
    const previous = theme;
    setTheme(next);
    try {
      await apiFetch<ThemeSetting>("/settings/theme", { method: "PUT", json: { theme: next } });
    } catch {
      // apiFetch already showed the error.
      setTheme(previous);
    }
  };

  return (
    <Segmented
      label={a.theme}
      value={theme}
      onChange={choose}
      options={OPTIONS.map(({ value, icon: Icon }) => ({
        value,
        label: (
          <span className="inline-flex items-center gap-1.5">
            <Icon className="size-4" aria-hidden />
            {a.options[value]}
          </span>
        ),
      }))}
      className="self-start"
    />
  );
}
