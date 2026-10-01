"use client";

import { useRouter } from "next/navigation";
import { useTransition } from "react";
import { Segmented } from "@/components/ui-kit/segmented";
import { useLocale, useT, writeLocaleCookie } from "@/i18n/client";
import { LOCALES, type Locale } from "@/i18n/config";
import { cn } from "@/lib/utils";

/** Each language names itself, so the toggle reads the same in both locales. */
const NAMES: Record<Locale, string> = { en: "EN", "zh-CN": "中文" };

/** "EN / 中文" on /settings: a pressed-button Segmented. Sets the `locale` cookie and refreshes so server components re-render. */
export function LanguageToggle({ className }: { className?: string }) {
  const router = useRouter();
  const t = useT();
  const locale = useLocale();
  const [pending, startTransition] = useTransition();

  const choose = (next: Locale) => {
    if (next === locale) return;
    writeLocaleCookie(next);
    startTransition(() => router.refresh());
  };

  return (
    <Segmented
      mode="pressed"
      label={t.nav.language}
      value={locale}
      onChange={choose}
      options={LOCALES.map((l) => ({ value: l, label: NAMES[l], lang: l }))}
      className={cn(pending && "opacity-60", className)}
    />
  );
}
