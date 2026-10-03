"use client";

// The add / edit payment method dialog: kind and label, contact fields, currencies, QR (with the Original crop step).

import { PAYMENT_ORIGINAL_MAX_BYTES } from "@yomi/contracts";
import {
  defaultPaymentCurrencies,
  defaultProfileFlags,
  hasRequiredContact,
  looksLikeEmail,
  PAYMENT_CONTACT_FIELDS,
  PAYMENT_KINDS,
  type PaymentContactField,
  type PaymentKind,
  type PaymentMethod,
  PROFILE_CONTACT_FIELDS,
  PROFILE_FLAG,
  type ProfileContactField,
  paymentFields,
  profileFields,
  resolveContact,
} from "@yomi/core/payment";
import { CheckIcon, CircleAlertIcon, CropIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useProfileContact } from "@/components/profile-settings";
import { CURRENCIES, Field, NativeSelect, Sheet, SheetActions, TextInput } from "@/components/split/ui";
import { DialogClose } from "@/components/ui/dialog";
import { Button } from "@/components/ui-kit/button";
import { phoneReady } from "@/components/ui-kit/phone-input";
import { Switch } from "@/components/ui-kit/switch";
import { useT } from "@/i18n/client";
import { autoCropRect, clampRect, type Rect, type Size, snapToCard } from "@/lib/qr-crop";
import { bitmapPixels, decodeDataUrl, encodeCrop, type QrRead, qrBox } from "@/lib/qr-decode";
import { cn } from "@/lib/utils";
import { PhoneField, ProfileChoice } from "./contact-fields";
import { methodTitle } from "./how-to-pay";
import { CropPreview, QrCropStep } from "./qr-crop";
import { DisplayChoice, QrField } from "./qr-field";

/** The form's copy of a method: label and contact fields as input text ("" for empty). */
export type Draft = Omit<PaymentMethod, "label" | PaymentContactField> & { label: string } & Record<PaymentContactField, string>;

export const blank = (kind: PaymentKind = "zelle"): Draft => ({
  kind,
  label: "",
  email: "",
  phone: "",
  username: "",
  text: "",
  ...defaultProfileFlags(kind),
  qr: null,
  original: null,
  display: "clean",
  currencies: defaultPaymentCurrencies(kind),
  showOnStatement: true,
});

export const toDraft = (m: PaymentMethod): Draft => ({
  ...m,
  label: m.label ?? "",
  email: m.email ?? "",
  phone: m.phone ?? "",
  username: m.username ?? "",
  text: m.text ?? "",
});

/** The screenshot a QR was just read from, kept in memory while the dialog is open (never stored or sent). */
interface Source {
  url: string;
  bitmap: ImageBitmap;
  size: Size;
  /** The first crop: fitted around the QR (and snapped to the card's edges when they are clear). */
  fitted: Rect;
}

/** The add / edit form (md dialog). Saving replaces the whole list; the dialog stays open on an error. */
export function MethodDialog({ initial, isNew, onSave }: { initial: Draft; isNew: boolean; onSave: (d: Draft) => Promise<boolean> }) {
  const t = useT();
  const s = t.settings.payment;
  const [d, setD] = useState<Draft>(initial);
  const [touched, setTouched] = useState(!isNew);
  const [problem, setProblem] = useState<string | null>(null);
  const [invalid, setInvalid] = useState<Partial<Record<PaymentContactField, string>>>({});
  const [saving, setSaving] = useState(false);
  // The Original crop: the screenshot at hand (this session's import), the box last used, and the crop step.
  const [source, setSource] = useState<Source | null>(null);
  const [box, setBox] = useState<Rect | null>(null);
  const [step, setStep] = useState<"form" | "crop">("form");
  const [applying, setApplying] = useState(false);
  const [cropError, setCropError] = useState<string | null>(null);
  const [scan, setScan] = useState<"checking" | "ok" | "fail" | null>(null);
  const originalRadio = useRef<HTMLInputElement>(null);
  const returnFocus = useRef(false);
  const sourceRef = useRef<Source | null>(null);

  const dropSource = () => {
    const old = sourceRef.current;
    if (old) {
      URL.revokeObjectURL(old.url);
      old.bitmap.close();
    }
    sourceRef.current = null;
    setSource(null);
    setBox(null);
  };
  useEffect(
    () => () => {
      const old = sourceRef.current;
      if (old) {
        URL.revokeObjectURL(old.url);
        old.bitmap.close();
      }
    },
    [],
  );

  /** A new image: Clean again, with a fresh Original candidate fitted around the QR. */
  const onImage = async (read: QrRead, file: Blob) => {
    const bitmap = await createImageBitmap(file).catch(() => null);
    dropSource();
    if (bitmap) {
      const size = { width: bitmap.width, height: bitmap.height };
      const qrRect = qrBox(read);
      let fitted = qrRect ? autoCropRect(qrRect, size) : clampRect({ x: 0, y: 0, ...size }, size);
      // The card's edges from the pixels (skipped for very large photos, where reading them all would be slow).
      if (qrRect && size.width * size.height <= 16_000_000) {
        const px = bitmapPixels(bitmap);
        if (px) fitted = snapToCard(fitted, qrRect, px);
      }
      const next = { url: URL.createObjectURL(file), bitmap, size, fitted };
      sourceRef.current = next;
      setSource(next);
      setBox(fitted);
    }
    setCropError(null);
    set({ qr: read.text, original: null, display: "clean" });
  };
  /** Link text, or Remove: no image, so only Clean exists. */
  const onQrText = (qr: string | null) => {
    dropSource();
    set({ qr, original: null, display: "clean" });
  };
  const chooseOriginal = () => {
    if (source) {
      setCropError(null);
      setStep("crop");
    } else if (d.original) set({ display: "original" });
  };
  const backToForm = () => {
    returnFocus.current = true;
    setStep("form");
  };
  const applyCrop = async (rect: Rect) => {
    if (!source) return;
    setApplying(true);
    try {
      const encoded = await encodeCrop(source.bitmap, rect, PAYMENT_ORIGINAL_MAX_BYTES);
      if (!encoded) return setCropError(s.originalTooLarge);
      setBox(rect);
      set({ original: encoded, display: "original" });
      backToForm();
    } finally {
      setApplying(false);
    }
  };
  useEffect(() => {
    if (step === "form" && returnFocus.current) {
      returnFocus.current = false;
      originalRadio.current?.focus();
    }
  }, [step]);
  // Before saving Original: does the stored crop itself scan (read locally, as a phone would read the print)?
  useEffect(() => {
    if (d.display !== "original" || !d.original || !d.qr) {
      setScan(null);
      return;
    }
    let live = true;
    setScan("checking");
    void decodeDataUrl(d.original.dataUrl).then((text) => {
      if (live) setScan(text === d.qr ? "ok" : "fail");
    });
    return () => {
      live = false;
    };
  }, [d.display, d.original, d.qr]);
  // A value upgraded from the old single field into one this kind does not show stays visible, so it is never lost.
  const [extra] = useState(() =>
    PAYMENT_CONTACT_FIELDS.filter(
      (f) => initial[f].trim() && !paymentFields(initial.kind).includes(f) && !(profileFields(initial.kind) as readonly string[]).includes(f),
    ),
  );
  // Email / phone: the profile's (a checkbox) unless this method has its own value (the override field).
  const [ownMode, setOwnMode] = useState<Record<ProfileContactField, boolean>>(() => ({ email: initial.email.trim() !== "", phone: initial.phone.trim() !== "" }));
  const [flagsTouched, setFlagsTouched] = useState(!isNew);
  const { contact: profile } = useProfileContact();
  const set = (patch: Partial<Draft>) => {
    setD((prev) => ({ ...prev, ...patch }));
    setProblem(null);
  };
  const options = [...new Set(["USD", ...CURRENCIES, ...d.currencies])];
  const name = methodTitle(t, { kind: d.kind, label: d.label.trim() || null });
  const own = paymentFields(d.kind);
  const shared = profileFields(d.kind);
  const shown = [...own, ...extra.filter((f) => !own.includes(f))];
  const needed = own[0];
  // A phone in use must be a valid number (or empty) before the method saves; the phone field explains why.
  const phoneBlocked = (shown.includes("phone") || (shared.includes("phone") && ownMode.phone)) && !phoneReady(d.phone);

  const fieldLabel = (f: PaymentContactField): string => {
    if (f === "email") return s.email;
    if (f === "phone") return s.phone;
    if (f === "username") return s.username;
    return d.kind === "alipay" || d.kind === "wechat" ? s.account : s.textOrLink;
  };
  const placeholder = (f: PaymentContactField): string => {
    if (f === "email" || f === "phone") return s.placeholders[f];
    const k = d.kind;
    return k === "zelle" ? s.placeholders.other : s.placeholders[k];
  };
  const needMessage =
    d.kind === "zelle"
      ? s.needContact.zelle
      : needed === "username"
        ? s.needContact.username
        : d.kind === "other"
          ? s.needContact.other
          : s.needContact.account;

  /**
   * The values to save: trimmed, only the fields this form shows. Email and phone: the override while it is open and
   * filled, else the profile flag (an empty override falls back to it).
   */
  const values = () => {
    const c = Object.fromEntries(PAYMENT_CONTACT_FIELDS.map((f) => [f, shown.includes(f) ? d[f].trim() || null : null])) as Record<
      PaymentContactField,
      string | null
    >;
    const flags = { useProfileEmail: false, useProfilePhone: false };
    for (const f of PROFILE_CONTACT_FIELDS) {
      if (!shared.includes(f)) continue;
      const value = ownMode[f] ? d[f].trim() : "";
      if (value) c[f] = value;
      else flags[PROFILE_FLAG[f]] = d[PROFILE_FLAG[f]];
    }
    return { c, flags };
  };

  const submit = async () => {
    const { c, flags } = values();
    const bad: Partial<Record<PaymentContactField, string>> = {};
    if (c.email && !looksLikeEmail(c.email)) bad.email = s.badEmail;
    if (c.phone && !phoneReady(c.phone)) bad.phone = s.badPhone;
    setInvalid(bad);
    if (Object.keys(bad).length > 0) return;
    if (!hasRequiredContact({ kind: d.kind, qr: d.qr, ...resolveContact({ kind: d.kind, ...c, ...flags }, profile) })) return setProblem(needMessage);
    if (d.currencies.length === 0) return setProblem(s.needCurrency);
    setSaving(true);
    try {
      await onSave({ ...d, ...flags, ...Object.fromEntries(PAYMENT_CONTACT_FIELDS.map((f) => [f, c[f] ?? ""])) });
    } finally {
      setSaving(false);
    }
  };

  const originalPreview =
    source && box ? (
      <CropPreview src={source.url} image={source.size} rect={box} maxHeight={96} className="rounded-md border border-border" />
    ) : d.original ? (
      <img
        src={d.original.dataUrl}
        width={d.original.width}
        height={d.original.height}
        alt=""
        className="block h-auto max-h-24 w-auto max-w-full rounded-md border border-border"
      />
    ) : null;
  const choice =
    d.qr && originalPreview ? (
      <div className="flex flex-col gap-2" data-scan={scan ?? undefined}>
        <DisplayChoice
          value={d.display}
          qr={d.qr}
          name={name}
          original={originalPreview}
          originalRef={originalRadio}
          onClean={() => set({ display: "clean" })}
          onOriginal={chooseOriginal}
        />
        {d.display === "original" && source && (
          <Button type="button" variant="ghost" size="sm" className="self-start" onClick={chooseOriginal}>
            <CropIcon aria-hidden />
            {s.cropAdjust}
          </Button>
        )}
        {scan === "fail" && (
          <p role="status" className="flex flex-wrap items-center gap-x-2 gap-y-1 text-meta" data-testid="qr-scan-warning">
            <CircleAlertIcon className="size-3.5 shrink-0 text-2" aria-hidden />
            <span>{s.scanWarning}</span>
            <Button type="button" variant="outline" size="sm" onClick={() => set({ display: "clean" })}>
              {s.useClean}
            </Button>
          </p>
        )}
      </div>
    ) : undefined;

  if (step === "crop" && source && box) {
    return (
      <Sheet
        title={s.cropTitle}
        description={s.cropHint}
        size="md"
        onEscapeKeyDown={(e) => {
          e.preventDefault();
          backToForm();
        }}
      >
        <QrCropStep
          src={source.url}
          image={source.size}
          initial={box}
          fitted={source.fitted}
          busy={applying}
          error={cropError}
          onBack={backToForm}
          onApply={(rect) => void applyCrop(rect)}
        />
      </Sheet>
    );
  }

  return (
    <Sheet title={isNew ? s.addTitle : s.editTitle} description={s.formHint} size="md">
      <form
        className="flex flex-col gap-4"
        data-testid="payment-form"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label={s.kind}>
            <NativeSelect
              value={d.kind}
              onChange={(e) => {
                const kind = e.target.value as PaymentKind;
                set({ kind, ...(touched ? {} : { currencies: defaultPaymentCurrencies(kind) }), ...(flagsTouched ? {} : defaultProfileFlags(kind)) });
              }}
            >
              {PAYMENT_KINDS.map((k) => (
                <option key={k} value={k}>
                  {s.kinds[k]}
                </option>
              ))}
            </NativeSelect>
          </Field>
          <Field label={s.label}>
            <TextInput value={d.label} maxLength={40} placeholder={s.labelPlaceholder} onChange={(e) => set({ label: e.target.value })} />
          </Field>
        </div>
        <div className="flex flex-col gap-3" data-testid="payment-contact">
          {shown.length > 0 && (
            <div className={cn("grid gap-3", shown.length > 1 && "sm:grid-cols-2")}>
              {shown.map((f) =>
                f === "phone" ? (
                  <PhoneField key={f} label={fieldLabel(f)} id="payment-phone" value={d.phone} onChange={(v) => set({ phone: v })} />
                ) : (
                <Field
                  key={f}
                  label={fieldLabel(f)}
                  hint={invalid[f] ? undefined : f === needed && d.qr ? s.optionalWithQr : undefined}
                  className={shown.length > 2 && f === shown[shown.length - 1] && shown.length % 2 === 1 ? "sm:col-span-2" : undefined}
                >
                  <TextInput
                    value={d[f]}
                    maxLength={200}
                    placeholder={placeholder(f)}
                    autoComplete="off"
                    type="text"
                    inputMode={f === "email" ? "email" : undefined}
                    aria-invalid={invalid[f] ? true : undefined}
                    onChange={(e) => {
                      set({ [f]: e.target.value });
                      if (invalid[f]) setInvalid((prev) => ({ ...prev, [f]: undefined }));
                    }}
                  />
                  {invalid[f] && (
                    <span role="alert" className="flex items-center gap-1.5 text-meta">
                      <CircleAlertIcon className="size-3.5 shrink-0 text-2" aria-hidden />
                      {invalid[f]}
                    </span>
                  )}
                </Field>
                ),
              )}
            </div>
          )}
          {shared.map((f) => (
            <ProfileChoice
              key={f}
              field={f}
              checked={d[PROFILE_FLAG[f]]}
              own={d[f]}
              ownMode={ownMode[f]}
              invalid={invalid[f]}
              onCheck={(on) => {
                setFlagsTouched(true);
                set({ [PROFILE_FLAG[f]]: on });
              }}
              onOwn={(value) => {
                set({ [f]: value });
                if (invalid[f]) setInvalid((prev) => ({ ...prev, [f]: undefined }));
              }}
              onOwnMode={(on) => {
                setOwnMode((prev) => ({ ...prev, [f]: on }));
                setInvalid((prev) => ({ ...prev, [f]: undefined }));
                // Back to the profile: its value shows again (ticked); the override is dropped on save.
                if (!on) {
                  setFlagsTouched(true);
                  set({ [f]: "", [PROFILE_FLAG[f]]: true });
                }
              }}
            />
          ))}
        </div>
        <fieldset className="flex flex-col gap-1">
          <legend className="mb-1 text-meta text-2">{s.currencies}</legend>
          <div className="flex flex-wrap gap-x-5 gap-y-1">
            {options.map((c) => (
              <label key={c} className="hit relative flex h-8 items-center gap-2 text-body">
                <input
                  type="checkbox"
                  className="size-4 accent-primary"
                  checked={d.currencies.includes(c)}
                  onChange={(e) => {
                    setTouched(true);
                    set({ currencies: e.target.checked ? [...d.currencies, c] : d.currencies.filter((x) => x !== c) });
                  }}
                />
                {c}
              </label>
            ))}
          </div>
        </fieldset>
        <QrField kind={d.kind} username={d.username} value={d.qr} name={name} choice={choice} onChange={onQrText} onImage={onImage} />
        <Switch label={s.show} help={s.showHelp} checked={d.showOnStatement} onChange={(v) => set({ showOnStatement: v })} />
        {problem && (
          <p role="alert" className="flex items-center gap-1.5 text-meta">
            <CircleAlertIcon className="size-3.5 shrink-0 text-2" aria-hidden />
            {problem}
          </p>
        )}
        <SheetActions>
          <DialogClose asChild>
            <Button type="button" variant="ghost">
              {t.common.cancel}
            </Button>
          </DialogClose>
          <Button type="submit" variant="primary" disabled={saving || phoneBlocked}>
            <CheckIcon aria-hidden />
            {saving ? t.common.saving : t.common.save}
          </Button>
        </SheetActions>
      </form>
    </Sheet>
  );
}
