"use client";

import type { ProfileSetting } from "@yomi/contracts";
import { looksLikeEmail, type ProfileContact, type ProfileContactField } from "@yomi/core/payment";
import { CircleAlertIcon } from "lucide-react";
import { createContext, type ReactNode, useContext, useRef, useState } from "react";
import { toast } from "sonner";
import { Input } from "@/components/ui/input";
import { PhoneInput, phoneReady } from "@/components/ui-kit/phone-input";
import { useT } from "@/i18n/client";
import { apiFetch } from "@/lib/api";

interface ProfileContactState {
  contact: ProfileContact;
  /** PUTs one field to /api/settings/profile (empty clears it) and toasts; null when the request failed. */
  saveContact: (field: ProfileContactField, value: string) => Promise<ProfileContact | null>;
}

const ProfileContactContext = createContext<ProfileContactState | null>(null);

/**
 * Holds Settings > Profile's email and phone for the Profile panel: the fields below "Your name" and the payment
 * method dialog (its "Show my email" checkboxes and the inline "Add your email in Profile" field) read and save the
 * same values.
 */
export function ProfileContactProvider({ initial, children }: { initial: ProfileContact; children: ReactNode }) {
  const t = useT();
  const s = t.settings.profile;
  const [contact, setContact] = useState(initial);
  const saveContact = async (field: ProfileContactField, value: string) => {
    try {
      const r = await apiFetch<ProfileSetting>("/settings/profile", { method: "PUT", json: { [field]: value.trim() } });
      const next = { email: r.email, phone: r.phone };
      setContact(next);
      toast.success(field === "email" ? (next.email ? s.emailSaved : s.emailCleared) : next.phone ? s.phoneSaved : s.phoneCleared);
      return next;
    } catch {
      return null; // apiFetch already showed the error.
    }
  };
  return <ProfileContactContext.Provider value={{ contact, saveContact }}>{children}</ProfileContactContext.Provider>;
}

export function useProfileContact(): ProfileContactState {
  const state = useContext(ProfileContactContext);
  if (!state) throw new Error("useProfileContact needs a ProfileContactProvider");
  return state;
}

/** The email / phone check the payment methods use; the message key when the value does not pass. */
export function contactProblem(field: ProfileContactField, value: string): "badEmail" | "badPhone" | null {
  const v = value.trim();
  if (!v) return null;
  if (field === "email") return looksLikeEmail(v) ? null : "badEmail";
  return phoneReady(v) ? null : "badPhone";
}

/**
 * Profile's phone: `PhoneInput` (country picker, formatted as typed), saved as E.164 when focus leaves it or on Enter;
 * an incomplete number is not saved (the input explains), empty clears it.
 */
function PhoneField() {
  const t = useT();
  const s = t.settings.profile;
  const { contact, saveContact } = useProfileContact();
  const saved = contact.phone ?? "";
  const busy = useRef(false);
  const mine = useRef<string | null>(null);
  const [seen, setSeen] = useState(saved);
  const [revision, setRevision] = useState(0);
  // A save from the payment method dialog updates the shared value: remount the input with it (not after our own save).
  if (seen !== saved) {
    setSeen(saved);
    if (saved !== mine.current) setRevision((r) => r + 1);
  }
  const save = async (next: string) => {
    if (busy.current || next === saved || !phoneReady(next)) return;
    busy.current = true;
    try {
      mine.current = next;
      await saveContact("phone", next);
    } finally {
      busy.current = false;
    }
  };
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <label htmlFor="profile-phone" className="text-body font-medium">
        {s.phone}
      </label>
      <PhoneInput key={revision} id="profile-phone" testId="profile-phone" value={saved} onCommit={(v) => void save(v)} />
    </div>
  );
}

/** Profile's email: saves on blur or Enter after the same check as the payment methods. */
function ContactField({ field }: { field: "email" }) {
  const t = useT();
  const s = t.settings.profile;
  const { contact, saveContact } = useProfileContact();
  const saved = contact[field] ?? "";
  const [value, setValue] = useState(saved);
  const [problem, setProblem] = useState<string | null>(null);
  const [seen, setSeen] = useState(saved);
  const busy = useRef(false);
  // A save from the payment method dialog updates the shared value; show it here too.
  if (seen !== saved) {
    setSeen(saved);
    setValue(saved);
    setProblem(null);
  }

  const save = async () => {
    const next = value.trim();
    if (busy.current) return;
    if (next === saved) {
      setValue(next);
      return;
    }
    const bad = contactProblem(field, next);
    if (bad) return setProblem(t.settings.payment[bad]);
    busy.current = true;
    try {
      await saveContact(field, next);
    } finally {
      busy.current = false;
    }
  };

  const id = `profile-${field}`;
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <label htmlFor={id} className="text-body font-medium">
        {s.email}
      </label>
      <Input
        id={id}
        value={value}
        maxLength={200}
        placeholder={t.settings.payment.placeholders.email}
        type="email"
        inputMode="email"
        autoComplete="email"
        aria-describedby="profile-contact-hint"
        aria-invalid={problem ? true : undefined}
        data-testid={id}
        className="h-10 text-body"
        onChange={(e) => {
          setValue(e.target.value);
          setProblem(null);
        }}
        onBlur={() => void save()}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            void save();
          }
        }}
      />
      {problem && (
        <span role="alert" className="flex items-center gap-1.5 text-meta">
          <CircleAlertIcon className="size-3.5 shrink-0 text-2" aria-hidden />
          {problem}
        </span>
      )}
    </div>
  );
}

/**
 * Settings > Profile: "Your name", shown on statements as "Sam's share" in place of "My share", then "Email" and
 * "Phone" (a country picker and the number, stored as E.164), which payment methods show (never printed on their
 * own). Each saves on blur or Enter (trimmed; the name at most 40 characters, the email with the payment methods'
 * check, the phone only once it is a valid number); an empty value clears it. Needs a
 * ProfileContactProvider.
 */
export function ProfileSettings({ initialName }: { initialName: string | null }) {
  const t = useT();
  const s = t.settings.profile;
  const [saved, setSaved] = useState(initialName ?? "");
  const [value, setValue] = useState(initialName ?? "");
  const busy = useRef(false);

  const save = async () => {
    const next = value.trim();
    if (busy.current) return;
    if (next === saved) {
      setValue(next);
      return;
    }
    busy.current = true;
    try {
      const r = await apiFetch<ProfileSetting>("/settings/profile", { method: "PUT", json: { displayName: next } });
      setSaved(r.displayName ?? "");
      setValue(r.displayName ?? "");
      toast.success(r.displayName ? s.saved : s.cleared);
    } catch {
      // apiFetch already showed the error.
    } finally {
      busy.current = false;
    }
  };

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-2">
        <label htmlFor="profile-name" className="text-body font-medium">
          {s.name}
        </label>
        <p id="profile-name-hint" className="text-body text-2">
          {s.hint}
        </p>
        <Input
          id="profile-name"
          value={value}
          maxLength={40}
          placeholder={s.placeholder}
          autoComplete="name"
          aria-describedby="profile-name-hint"
          data-testid="profile-name"
          className="h-10 max-w-xs text-body"
          onChange={(e) => setValue(e.target.value)}
          onBlur={() => void save()}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              void save();
            }
          }}
        />
      </div>
      <div className="flex flex-col gap-2">
        <div className="grid gap-4 sm:max-w-xl sm:grid-cols-2">
          <ContactField field="email" />
          <PhoneField />
        </div>
        <p id="profile-contact-hint" className="text-body text-2">
          {s.contactHint}
        </p>
      </div>
    </div>
  );
}
