import Link from "next/link";
import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

export interface SegmentedOption<T> {
  value: T;
  label: ReactNode;
  /** Link mode: where the segment goes (the URL is the state). */
  href?: string;
  /** Link and pressed modes: the language of the label, when it differs from the page. */
  lang?: string;
}

const well = "inline-flex w-fit max-w-full flex-wrap gap-0.5 rounded-md bg-sunken p-0.5";
const segment =
  "hit relative inline-flex h-8 min-w-0 shrink-0 items-center justify-center rounded-[5px] px-3 text-body whitespace-nowrap transition-colors duration-[120ms] outline-none focus-visible:ring-2 focus-visible:ring-ring/50";
const on = "bg-surface font-medium text-foreground ring-1 ring-border";
const off = "text-2 hover:text-foreground";

/**
 * One segmented control. Modes: `radio` (role radiogroup, the default: Items / Text, Everything / Choose items),
 * `pressed` (role group with aria-pressed buttons: EN / 中文), `links` (a nav of links with aria-current: Assets
 * "Total in"). Segments are 32px high with a 44px hit area on phones, 15px text; the well wraps instead of scrolling.
 */
export function Segmented<T extends string | boolean | null>({
  value,
  options,
  onChange,
  label,
  mode = "radio",
  className,
}: {
  value: T;
  options: SegmentedOption<T>[];
  onChange?: (v: T) => void;
  /** Accessible name of the group. */
  label: string;
  mode?: "radio" | "pressed" | "links";
  className?: string;
}) {
  if (mode === "links") {
    return (
      <nav aria-label={label} className={className}>
        <ul className={well}>
          {options.map((o) => (
            <li key={String(o.value)} className="min-w-0">
              <Link
                href={o.href ?? "#"}
                scroll={false}
                lang={o.lang}
                aria-current={o.value === value ? "page" : undefined}
                className={cn(segment, o.value === value ? on : off)}
              >
                {o.label}
              </Link>
            </li>
          ))}
        </ul>
      </nav>
    );
  }
  return (
    <div role={mode === "radio" ? "radiogroup" : "group"} aria-label={label} className={cn(well, className)}>
      {options.map((o) => (
        <button
          key={String(o.value)}
          type="button"
          lang={o.lang}
          {...(mode === "radio" ? { role: "radio", "aria-checked": o.value === value } : { "aria-pressed": o.value === value })}
          onClick={() => onChange?.(o.value)}
          className={cn(segment, o.value === value ? on : off)}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}
