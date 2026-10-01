"use client";

import {
  type CountryCode,
  getCountries,
  getCountryCallingCode,
  isE164Phone,
  parsePhone,
  PINNED_COUNTRIES,
  phoneCountry,
  phoneFieldText,
  typePhone,
} from "@yomi/core/phone";
import { ChevronDownIcon, CircleAlertIcon } from "lucide-react";
import { type ClipboardEvent, type FocusEvent, type KeyboardEvent, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { fmt } from "@/i18n";
import { useLocale, useT } from "@/i18n/client";
import { useTimeZone } from "@/lib/time-zone";
import { cn } from "@/lib/utils";

/** True for what `PhoneInput` reports when it can be saved: empty, or a valid number (E.164). */
export function phoneReady(value: string): boolean {
  return value.trim() === "" || isE164Phone(value);
}

const digitsOf = (text: string) => text.replace(/\D/g, "");

/** The index in `text` just after its `n`th digit (0: the start). */
function afterDigits(text: string, n: number): number {
  if (n <= 0) return 0;
  let seen = 0;
  for (let i = 0; i < text.length; i++) {
    if (/\d/.test(text[i]!)) seen++;
    if (seen === n) return i + 1;
  }
  return text.length;
}

const noSubscribe = () => () => {};

/**
 * Every country the metadata knows, by localized name, with the pinned ones (US, China) first. The server and the
 * browser name and sort countries with different ICU data, so the full list renders only after hydration (`rest` is
 * empty before).
 */
function useCountries(): { pinned: CountryCode[]; rest: CountryCode[]; name: (c: CountryCode) => string } {
  const locale = useLocale();
  const hydrated = useSyncExternalStore(
    noSubscribe,
    () => true,
    () => false,
  );
  return useMemo(() => {
    let names: Intl.DisplayNames | null = null;
    try {
      names = new Intl.DisplayNames([locale], { type: "region" });
    } catch {
      names = null;
    }
    const name = (c: CountryCode) => names?.of(c) ?? c;
    const collator = new Intl.Collator(locale);
    const pinned = [...PINNED_COUNTRIES];
    const rest = hydrated
      ? getCountries()
          .filter((c) => !pinned.includes(c))
          .sort((a, b) => collator.compare(name(a), name(b)))
      : [];
    return { pinned, rest, name };
  }, [locale, hydrated]);
}

/**
 * A phone number with its country: a compact picker on the left ("US +1", a native select over it, so typing a
 * letter while it is focused jumps through the list; United States and China first, a divider, then every other
 * country by localized name) and the number on the right, formatted as typed for that country (US as
 * "202-555-0143"). Typing or pasting a full "+86 …" number switches the country. The starting country is the stored
 * number's, else the user's time zone's (America/* US, Asia/Shanghai China), else US.
 *
 * `onChange` reports E.164 when the number is valid for the country, "" when empty, else the text as shown (see
 * `phoneReady`). A stored value that is not a valid number (typed before v0.1.30) shows as typed with a quiet "Check
 * this number" until it is edited; an invalid number gets a calm inline message once focus leaves the field or Enter
 * is pressed. `id` goes on the number input, so a `<label htmlFor>` names it.
 */
export function PhoneInput({
  id,
  value,
  onChange,
  onCommit,
  size = "md",
  autoFocus,
  testId,
  className,
}: {
  id?: string;
  /** The stored value to start from; remount (`key`) to reset. */
  value: string | null;
  onChange?: (value: string) => void;
  /** Focus left the field (number and picker) or Enter was pressed. */
  onCommit?: (value: string) => void;
  /** `md` 40px (Settings pages), `sm` 36px (dialog forms). */
  size?: "md" | "sm";
  autoFocus?: boolean;
  testId?: string;
  className?: string;
}) {
  const t = useT();
  const s = t.settings.phone;
  const timeZone = useTimeZone();
  const { pinned, rest, name } = useCountries();
  const [country, setCountry] = useState<CountryCode>(() => phoneCountry(value, timeZone));
  const [text, setText] = useState(() => phoneFieldText(value));
  const [legacy, setLegacy] = useState(() => Boolean(value?.trim()) && !isE164Phone(value ?? ""));
  const [touched, setTouched] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const caret = useRef<number | null>(null);

  useLayoutEffect(() => {
    if (caret.current === null || !input.current || document.activeElement !== input.current) return;
    input.current.setSelectionRange(caret.current, caret.current);
    caret.current = null;
  });

  const report = (nextText: string, nextCountry: CountryCode): string => {
    const out = nextText.trim() === "" ? "" : (parsePhone(nextText, nextCountry)?.e164 ?? nextText.trim());
    onChange?.(out);
    return out;
  };
  const current = () => (text.trim() === "" ? "" : (parsePhone(text, country)?.e164 ?? text.trim()));

  const apply = (raw: string, caretDigits: number | null) => {
    const next = typePhone(raw, country);
    setText(next.text);
    setLegacy(false);
    setTouched(false);
    if (next.country !== country) setCountry(next.country);
    caret.current = caretDigits === null || next.text.startsWith("+") || next.country !== country ? next.text.length : afterDigits(next.text, caretDigits);
    report(next.text, next.country);
  };

  const onInput = (el: HTMLInputElement) => {
    const raw = el.value;
    const at = el.selectionStart ?? raw.length;
    let digitsBefore = digitsOf(raw.slice(0, at)).length;
    let edited = raw;
    // Backspace over a separator only ("202-|555"): take the digit before it, or the edit would be undone.
    if (!raw.trim().startsWith("+") && raw.length < text.length && digitsOf(raw) === digitsOf(text) && digitsBefore > 0) {
      const cut = afterDigits(raw, digitsBefore) - 1;
      edited = raw.slice(0, cut) + raw.slice(cut + 1);
      digitsBefore -= 1;
    }
    apply(edited, at === raw.length ? null : digitsBefore);
  };

  const onPaste = (e: ClipboardEvent<HTMLInputElement>) => {
    const pasted = e.clipboardData.getData("text").trim();
    // A full international number replaces the field and picks its country.
    if (pasted.startsWith("+")) {
      e.preventDefault();
      apply(pasted, null);
    }
  };

  const pickCountry = (c: CountryCode) => {
    setCountry(c);
    setLegacy(false);
    const nextText = text.trim().startsWith("+") ? text : typePhone(digitsOf(text), c).text;
    setText(nextText);
    report(nextText, c);
  };

  const onBlur = (e: FocusEvent<HTMLDivElement>) => {
    if (e.currentTarget.contains(e.relatedTarget as Node | null)) return;
    setTouched(true);
    onCommit?.(current());
  };
  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key !== "Enter" || !onCommit) return;
    e.preventDefault();
    setTouched(true);
    onCommit(current());
  };

  const code = getCountryCallingCode(country);
  const invalid = touched && !legacy && !phoneReady(current());
  const messageId = id ? `${id}-message` : undefined;
  const option = (c: CountryCode) => (
    <option key={c} value={c} suppressHydrationWarning>
      {fmt(s.option, { name: name(c), code: getCountryCallingCode(c) })}
    </option>
  );

  return (
    <div className={cn("flex min-w-0 flex-col gap-1.5", className)} data-testid={testId}>
      <div
        onBlur={onBlur}
        className={cn(
          "flex w-full min-w-0 items-stretch rounded-lg border border-border bg-surface text-body transition-colors duration-[120ms] focus-within:border-primary focus-within:ring-2 focus-within:ring-primary/25",
          size === "md" ? "h-11 md:h-10" : "h-11 md:h-9",
        )}
      >
        <div className="relative flex shrink-0 items-center gap-1 rounded-l-lg border-r border-line-soft pr-1.5 pl-2.5 hover:bg-sunken">
          <span className="num whitespace-nowrap" aria-hidden data-testid={testId ? `${testId}-code` : undefined}>
            {fmt(s.code, { iso: country, code })}
          </span>
          <ChevronDownIcon className="size-3.5 shrink-0 text-2" aria-hidden />
          <select
            aria-label={s.country}
            value={country}
            onChange={(e) => pickCountry(e.target.value as CountryCode)}
            className="absolute inset-0 size-full cursor-pointer appearance-none opacity-0"
            data-testid={testId ? `${testId}-country` : undefined}
          >
            {pinned.map(option)}
            <hr />
            {(rest.length > 0 || pinned.includes(country) ? rest : [country]).map(option)}
          </select>
        </div>
        <input
          ref={input}
          id={id}
          type="tel"
          inputMode="tel"
          autoComplete="tel-national"
          autoFocus={autoFocus}
          maxLength={40}
          value={text}
          placeholder={s.placeholders[country] ?? ""}
          aria-invalid={invalid || legacy ? true : undefined}
          aria-describedby={invalid || legacy ? messageId : undefined}
          className="num w-full min-w-0 flex-1 rounded-r-lg bg-transparent px-2.5 text-left text-foreground outline-none placeholder:text-3"
          onChange={(e) => onInput(e.currentTarget)}
          onPaste={onPaste}
          onKeyDown={onKeyDown}
        />
      </div>
      {legacy && (
        <span id={messageId} className="text-meta text-2" data-testid={testId ? `${testId}-check` : undefined}>
          {s.check}
        </span>
      )}
      {invalid && (
        <span id={messageId} role="alert" className="flex items-center gap-1.5 text-meta">
          <CircleAlertIcon className="size-3.5 shrink-0 text-2" aria-hidden />
          {fmt(s.invalid, { country: name(country) })}
        </span>
      )}
    </div>
  );
}
