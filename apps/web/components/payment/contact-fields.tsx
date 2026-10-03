"use client";

// Contact fields of the payment method dialog: a phone field, and the profile's email or phone (or this method's own).

import type { ProfileContactField } from "@yomi/core/payment";
import { formatPhone } from "@yomi/core/phone";
import { CircleAlertIcon } from "lucide-react";
import { useRef, useState } from "react";
import { contactProblem, useProfileContact } from "@/components/profile-settings";
import { Field, TextInput } from "@/components/split/ui";
import { PhoneInput } from "@/components/ui-kit/phone-input";
import { fmt } from "@/i18n";
import { useT } from "@/i18n/client";
import { cn } from "@/lib/utils";

const quietLink =
  "hit relative rounded-sm text-left text-meta text-primary underline-offset-4 hover:underline focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none";

/** A phone field in the method dialog: the 13px label above (like `Field`), the country picker and the number. */
export function PhoneField({
  label,
  hint,
  id,
  value,
  autoFocus,
  onChange,
  onCommit,
}: {
  label: string;
  hint?: string;
  id: string;
  value: string;
  autoFocus?: boolean;
  onChange?: (value: string) => void;
  onCommit?: (value: string) => void;
}) {
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <label htmlFor={id} className="text-meta text-2">
        {label}
      </label>
      <PhoneInput id={id} testId={id} size="sm" value={value} autoFocus={autoFocus} onChange={onChange} onCommit={onCommit} />
      {hint && <span className="text-meta text-2">{hint}</span>}
    </div>
  );
}

/**
 * The profile's email or phone in the method dialog. With a profile value: a "Show my email (…)" checkbox and a quiet
 * "Use a different email" link that switches to this method's own value (an override, with a link back). Without
 * one: a quiet "Add your email in Profile" link that opens the profile field inline; saving it (blur or Enter) stores
 * it on the profile for every method and ticks the checkbox here.
 */
export function ProfileChoice({
  field,
  checked,
  own,
  ownMode,
  invalid,
  onCheck,
  onOwn,
  onOwnMode,
}: {
  field: ProfileContactField;
  checked: boolean;
  own: string;
  ownMode: boolean;
  invalid: string | undefined;
  onCheck: (on: boolean) => void;
  onOwn: (value: string) => void;
  onOwnMode: (on: boolean) => void;
}) {
  const t = useT();
  const s = t.settings.payment;
  const { contact, saveContact } = useProfileContact();
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState("");
  const [problem, setProblem] = useState<string | null>(null);
  const busy = useRef(false);
  const email = field === "email";
  const profileValue = contact[field];
  const alert = (text: string) => (
    <span role="alert" className="flex items-center gap-1.5 text-meta">
      <CircleAlertIcon className="size-3.5 shrink-0 text-2" aria-hidden />
      {text}
    </span>
  );
  const inputProps = {
    maxLength: email ? 200 : 40,
    placeholder: s.placeholders[field],
    autoComplete: "off",
    type: email ? "text" : "tel",
    inputMode: email ? ("email" as const) : ("tel" as const),
  };

  if (ownMode) {
    return (
      <div className="flex flex-col gap-1.5" data-testid={`payment-own-${field}`}>
        {email ? (
          <Field label={s.ownEmail}>
            <TextInput {...inputProps} value={own} aria-invalid={invalid ? true : undefined} onChange={(e) => onOwn(e.target.value)} />
            {invalid && alert(invalid)}
          </Field>
        ) : (
          <PhoneField label={s.ownPhone} id="payment-own-phone-input" value={own} onChange={onOwn} />
        )}
        <button type="button" className={cn(quietLink, "self-start")} onClick={() => onOwnMode(false)}>
          {email ? s.backToProfileEmail : s.backToProfilePhone}
        </button>
      </div>
    );
  }
  if (profileValue) {
    return (
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1" data-testid={`payment-profile-${field}`}>
        <label className="hit relative flex min-h-8 min-w-0 items-center gap-2 text-body">
          <input type="checkbox" className="size-4 shrink-0 accent-primary" checked={checked} onChange={(e) => onCheck(e.target.checked)} />
          <span className="min-w-0 break-words">{fmt(email ? s.showEmail : s.showPhone, { value: email ? profileValue : formatPhone(profileValue) })}</span>
        </label>
        <button type="button" className={quietLink} onClick={() => onOwnMode(true)}>
          {email ? s.differentEmail : s.differentPhone}
        </button>
      </div>
    );
  }
  const commit = async (typed: string = draft) => {
    const value = typed.trim();
    if (busy.current) return;
    if (!value) return setAdding(false);
    const bad = contactProblem(field, value);
    if (bad) return setProblem(s[bad]);
    busy.current = true;
    try {
      const next = await saveContact(field, value);
      if (next?.[field]) {
        onCheck(true);
        setAdding(false);
      }
    } finally {
      busy.current = false;
    }
  };
  if (adding && !email) {
    return (
      <PhoneField
        label={s.profilePhone}
        hint={s.profileInlineHint}
        id="payment-add-phone"
        value=""
        autoFocus
        onCommit={(value) => {
          setDraft(value);
          void commit(value);
        }}
      />
    );
  }
  if (adding) {
    return (
      <Field label={email ? s.profileEmail : s.profilePhone} hint={problem ? undefined : s.profileInlineHint}>
        <TextInput
          {...inputProps}
          autoFocus
          value={draft}
          data-testid={`payment-add-${field}`}
          aria-invalid={problem ? true : undefined}
          onChange={(e) => {
            setDraft(e.target.value);
            setProblem(null);
          }}
          onBlur={() => void commit()}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              void commit();
            }
          }}
        />
        {problem && alert(problem)}
      </Field>
    );
  }
  return (
    <button type="button" className={cn(quietLink, "self-start")} data-testid={`payment-add-${field}-link`} onClick={() => setAdding(true)}>
      {email ? s.addEmail : s.addPhone}
    </button>
  );
}
