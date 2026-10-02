"use client";

import { ChevronRightIcon, ExternalLinkIcon, EyeIcon, EyeOffIcon, LockIcon } from "lucide-react";
import type { IdentifierField, SecretField, SecretsView } from "@yomi/contracts";
import { type ComponentProps, type ReactNode, useState } from "react";
import { Checkbox } from "@/components/ui/checkbox";
import { fmt } from "@/i18n";
import { useLocale, useT } from "@/i18n/client";
import { rich } from "@/i18n/rich";
import { dayLabel } from "@/lib/month";
import { cn } from "@/lib/utils";

/** When the provider pages in the guides were last compared with the steps (update with the copy). */
export const GUIDES_CHECKED_ON = "2026-09-30";

/**
 * Numbered steps for getting a credential (13px text-2, links with an external-link icon, a
 * "Last checked" line). Step templates name their links as `{key}`; labels come from `labels`, URLs from `hrefs`.
 */
export function Guide({
  title,
  steps,
  labels,
  hrefs,
  testId,
  defaultOpen = true,
  checkedOn = GUIDES_CHECKED_ON,
  more,
}: {
  title: string;
  steps: readonly string[];
  labels: Record<string, string>;
  hrefs: Record<string, string>;
  testId?: string;
  /** Closed once the credential is set up: the steps are one click away. */
  defaultOpen?: boolean;
  /** Date the steps were verified against the official pages; null hides the "Last checked" line. */
  checkedOn?: string | null;
  /** A secondary, collapsed list after the steps (an alternative setup). */
  more?: { title: string; items: readonly string[] };
}) {
  const t = useT();
  const locale = useLocale();
  const links = Object.fromEntries(
    Object.entries(hrefs).map(([k, href]) => [
      k,
      <a key={k} href={href} target="_blank" rel="noreferrer noopener" className="inline-flex items-center gap-0.5 text-primary underline-offset-4 hover:underline">
        {labels[k] ?? href}
        <ExternalLinkIcon className="size-3" aria-hidden />
      </a>,
    ]),
  );
  return (
    <details open={defaultOpen} className="group rounded-lg bg-sunken px-4 py-3" data-testid={testId}>
      <summary className="flex cursor-pointer list-none items-center gap-2 text-meta font-medium text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring/50 [&::-webkit-details-marker]:hidden">
        <ChevronRightIcon className="size-3.5 shrink-0 text-2 transition-transform duration-[120ms] group-open:rotate-90" aria-hidden />
        {title}
      </summary>
      <ol className="mt-2 flex list-decimal flex-col gap-1.5 pl-4 text-meta text-2">
        {steps.map((s) => (
          <li key={s} className="pl-0.5">
            {rich(s, links)}
          </li>
        ))}
      </ol>
      {more && (
        <details className="group/more mt-2" data-testid={testId ? `${testId}-more` : undefined}>
          <summary className="flex cursor-pointer list-none items-center gap-2 text-meta font-medium text-2 outline-none focus-visible:ring-2 focus-visible:ring-ring/50 [&::-webkit-details-marker]:hidden">
            <ChevronRightIcon className="size-3.5 shrink-0 transition-transform duration-[120ms] group-open/more:rotate-90" aria-hidden />
            {more.title}
          </summary>
          <ul className="mt-1.5 flex list-disc flex-col gap-1 pl-5 text-meta text-2">
            {more.items.map((s) => (
              <li key={s}>{s}</li>
            ))}
          </ul>
        </details>
      )}
      {checkedOn && <p className="mt-2 text-hint text-3">{fmt(t.secrets.lastChecked, { date: dayLabel(checkedOn, locale, { year: true }) })}</p>}
    </details>
  );
}

const control =
  "h-10 w-full min-w-0 rounded-lg border border-border bg-surface px-3 text-body text-foreground outline-none transition-colors duration-[120ms] placeholder:text-3 focus-visible:border-primary focus-visible:ring-2 focus-visible:ring-primary/25 disabled:opacity-50";

/**
 * One credential field. From the environment: a read-only line "Set by environment" with its explanation.
 * A secret (`masked`): a password input that starts empty (empty keeps the saved value), a hint about what is saved,
 * and an eye button that shows what is being typed (only that: saved secrets never come back). An identifier
 * (`masked={false}`): a plain text input the caller prefills with the saved value.
 */
export function SecretInput({
  id,
  label,
  field,
  envName,
  value,
  onChange,
  hint,
  aside,
  inputProps,
  masked = true,
}: {
  id: string;
  label: string;
  field: SecretField | IdentifierField;
  /** Env variable that would override this field. */
  envName: string;
  value: string;
  onChange: (v: string) => void;
  /** Quiet line under the input when nothing more specific applies. */
  hint?: string;
  /** Next to the input (Test keys). */
  aside?: ReactNode;
  inputProps?: ComponentProps<"input">;
  /** false for identifiers that are not secret (Flex query ID, Plaid client ID): a plain text input, shown in clear. */
  masked?: boolean;
}) {
  const t = useT();
  const s = t.secrets;
  const [shown, setShown] = useState(false);
  // Hidden again once the input is empty (after saving, or cleared by hand).
  if (shown && value === "") setShown(false);
  if (field.source === "env") {
    return (
      <div className="flex min-w-0 flex-col gap-1" data-testid={`secret-${id}`}>
        <span className="text-meta text-2">{label}</span>
        <div className="flex flex-wrap items-center gap-2">
          <div className="flex h-10 min-w-0 flex-1 items-center gap-2 rounded-lg border border-border bg-sunken px-3 text-body text-2" aria-readonly="true">
            <LockIcon className="size-4 shrink-0" aria-hidden />
            <span className="truncate">{field.last4 ? fmt(s.envSetEnds, { last4: field.last4 }) : s.envSet}</span>
          </div>
          {aside && <div className="flex shrink-0 items-center gap-2">{aside}</div>}
        </div>
        <span className="text-meta text-2">{fmt(s.envHint, { name: envName })}</span>
      </div>
    );
  }
  const note =
    field.unreadable ? s.unreadable
    : masked && field.configured ? (field.last4 ? fmt(s.savedEnds, { last4: field.last4 }) : s.saved)
    : hint;
  const empty = value === "";
  const input = (
    <input
      id={`secret-input-${id}`}
      type={masked && !shown ? "password" : "text"}
      autoComplete="off"
      autoCapitalize="off"
      autoCorrect="off"
      spellCheck={false}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className={cn(control, "font-mono text-meta", masked ? "w-full pr-11" : "min-w-48 flex-1")}
      placeholder={masked && field.configured ? (field.last4 ? `•••• ${field.last4}` : "••••") : undefined}
      {...inputProps}
    />
  );
  return (
    <div className="flex min-w-0 flex-col gap-1" data-testid={`secret-${id}`}>
      <label htmlFor={`secret-input-${id}`} className="text-meta text-2">
        {label}
      </label>
      <div className="flex flex-wrap items-center gap-2">
        {masked ? (
          <div className="relative min-w-48 flex-1">
            {input}
            {(!empty || field.configured) && (
              <button
                type="button"
                aria-label={shown ? s.hideValue : s.showValue}
                aria-pressed={shown}
                aria-disabled={empty || undefined}
                aria-controls={`secret-input-${id}`}
                title={empty ? s.savedHidden : undefined}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => !empty && setShown((v) => !v)}
                className="hit absolute top-1/2 right-1 grid size-8 -translate-y-1/2 place-items-center rounded-md text-2 outline-none transition-colors duration-[120ms] hover:bg-sunken hover:text-foreground focus-visible:ring-2 focus-visible:ring-primary/25 aria-disabled:cursor-default aria-disabled:opacity-50 aria-disabled:hover:bg-transparent aria-disabled:hover:text-2"
                data-testid={`secret-toggle-${id}`}
              >
                {shown ? <EyeOffIcon className="size-4" aria-hidden /> : <EyeIcon className="size-4" aria-hidden />}
              </button>
            )}
          </div>
        ) : (
          input
        )}
        {aside && <div className="flex shrink-0 items-center gap-2">{aside}</div>}
      </div>
      {note && <span className={cn("text-meta", field.unreadable ? "text-foreground" : "text-2")}>{note}</span>}
    </div>
  );
}

/** One line on where saved secrets are encrypted and that the key file needs a backup. */
export function KeyNote({ keyInfo }: { keyInfo: SecretsView["key"] }) {
  const s = useT().secrets;
  const text =
    keyInfo.state === "malformed" ? s.keyMalformed
    : keyInfo.source === "env" ? s.keyEnv
    : keyInfo.source === "file" ? fmt(s.keyFile, { file: keyInfo.file ?? "" })
    : fmt(s.keyNone, { file: keyInfo.file ?? "" });
  return (
    <p className={cn("text-meta break-words", keyInfo.state === "malformed" ? "text-foreground" : "text-2")} data-testid="secret-key-note">
      {text}
    </p>
  );
}

/** "Save without a successful test": the calm opt-out, with its warning while ticked. */
export function UntestedToggle({ checked, onChange }: { checked: boolean; onChange: (v: boolean) => void }) {
  const s = useT().secrets;
  return (
    <div className="flex flex-col gap-1">
      <label className="flex min-h-8 cursor-pointer items-center gap-2 text-meta text-2">
        <Checkbox checked={checked} onCheckedChange={(v) => onChange(v === true)} />
        {s.untested}
      </label>
      {checked && <p className="text-meta text-2">{s.untestedWarning}</p>}
    </div>
  );
}
