"use client";

import { PAYMENT_ORIGINAL_MAX_BYTES, type PaymentMethodsSetting } from "@yomi/contracts";
import {
  defaultPaymentCurrencies,
  defaultProfileFlags,
  hasRequiredContact,
  linkText,
  looksLikeEmail,
  PAYMENT_CONTACT_FIELDS,
  PAYMENT_KINDS,
  PAYMENT_METHODS_MAX,
  type PaymentContactField,
  type PaymentKind,
  type PaymentMethod,
  PROFILE_CONTACT_FIELDS,
  PROFILE_FLAG,
  type ProfileContactField,
  paymentFields,
  paymentLink,
  profileFields,
  resolveContact,
} from "@yomi/core/payment";
import { formatPhone } from "@yomi/core/phone";
import {
  ArrowDownIcon,
  ArrowUpIcon,
  CheckIcon,
  CircleAlertIcon,
  ImageUpIcon,
  LinkIcon,
  CropIcon,
  PencilIcon,
  PlusIcon,
  QrCodeIcon,
  Trash2Icon,
  XIcon,
} from "lucide-react";
import { type ReactNode, type Ref, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { methodTitle, paymentKindIcon } from "@/components/payment/how-to-pay";
import { QrCode } from "@/components/payment/qr-code";
import { CropPreview, QrCropStep } from "@/components/payment/qr-crop";
import { contactProblem, useProfileContact } from "@/components/profile-settings";
import { CURRENCIES, Field, NativeSelect, Sheet, SheetActions, TextInput } from "@/components/split/ui";
import { Dialog, DialogClose } from "@/components/ui/dialog";
import { Button } from "@/components/ui-kit/button";
import { PhoneInput, phoneReady } from "@/components/ui-kit/phone-input";
import { IconTile } from "@/components/ui-kit/icon-tile";
import { ListCard } from "@/components/ui-kit/list-card";
import { Switch } from "@/components/ui-kit/switch";
import { fmt } from "@/i18n";
import { useT } from "@/i18n/client";
import { apiFetch } from "@/lib/api";
import { autoCropRect, clampRect, type Rect, type Size, snapToCard } from "@/lib/qr-crop";
import { bitmapPixels, decodeDataUrl, encodeCrop, type QrRead, qrBox, readQrImage } from "@/lib/qr-decode";
import { cn } from "@/lib/utils";

const QR_MAX = 2048;

/** The form's copy of a method: label and contact fields as input text ("" for empty). */
type Draft = Omit<PaymentMethod, "label" | PaymentContactField> & { label: string } & Record<PaymentContactField, string>;

const blank = (kind: PaymentKind = "zelle"): Draft => ({
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

const toDraft = (m: PaymentMethod): Draft => ({
  ...m,
  label: m.label ?? "",
  email: m.email ?? "",
  phone: m.phone ?? "",
  username: m.username ?? "",
  text: m.text ?? "",
});

/** The contact values a method shows, for its list row: email, phone (`formatPhone`), username, text; profile values resolved. */
function contactSummary(m: PaymentMethod, profile: Parameters<typeof resolveContact>[1]): string[] {
  const c = resolveContact(m, profile);
  return [c.email, c.phone ? formatPhone(c.phone) : null, c.username, c.text].filter((v): v is string => Boolean(v));
}

const quietLink =
  "hit relative rounded-sm text-left text-meta text-primary underline-offset-4 hover:underline focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none";

/** A phone field in the method dialog: the 13px label above (like `Field`), the country picker and the number. */
function PhoneField({
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
function ProfileChoice({
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

/**
 * "Add QR code" for one method: drop or pick a screenshot or photo, paste an image with ⌘V while the dialog is open,
 * or paste the code's link text. Images are decoded here (BarcodeDetector or jsQR): `onImage` gets the text, where the
 * code sits and the image (for the Original crop, kept in memory only); link text goes to `onChange`. `choice` (the
 * Clean / Original previews) replaces the single preview when there is an image to choose from.
 */
function QrField({
  kind,
  username,
  value,
  name,
  choice,
  onChange,
  onImage,
}: {
  kind: PaymentKind;
  username: string;
  value: string | null;
  name: string;
  choice?: ReactNode;
  onChange: (qr: string | null) => void;
  onImage: (read: QrRead, file: Blob) => Promise<void>;
}) {
  const t = useT();
  const s = t.settings.payment;
  const [state, setState] = useState<"idle" | "reading" | "error">("idle");
  const [link, setLink] = useState("");
  const [over, setOver] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const change = useRef(onChange);
  useEffect(() => {
    change.current = onChange;
  });

  const read = async (file: Blob) => {
    setState("reading");
    const found = await readQrImage(file);
    if (found) {
      await onImage({ ...found, text: found.text.slice(0, QR_MAX) }, file);
      setState("idle");
    } else setState("error");
  };
  const readRef = useRef(read);
  useEffect(() => {
    readRef.current = read;
  });

  useEffect(() => {
    const onPaste = (e: ClipboardEvent) => {
      const image = [...(e.clipboardData?.files ?? [])].find((f) => f.type.startsWith("image/"));
      if (image) {
        e.preventDefault();
        void readRef.current(image);
        return;
      }
      // Link text pasted outside a text field is the QR's payload too.
      const target = e.target as HTMLElement | null;
      if (target?.closest("input, textarea, [contenteditable=true]")) return;
      const text = e.clipboardData?.getData("text/plain").trim();
      if (text && !text.includes("\n")) {
        e.preventDefault();
        change.current(text.slice(0, QR_MAX));
        setState("idle");
      }
    };
    document.addEventListener("paste", onPaste);
    return () => document.removeEventListener("paste", onPaste);
  }, []);

  const picker = (
    <input
      ref={fileRef}
      type="file"
      accept="image/*,.heic,.heif"
      className="sr-only"
      tabIndex={-1}
      aria-hidden
      data-testid="qr-file"
      onChange={(e) => {
        const file = e.target.files?.[0];
        e.target.value = "";
        if (file) void read(file);
      }}
    />
  );
  const built = kind === "venmo" || kind === "paypal" || kind === "cashapp" ? paymentLink({ kind, username }) : null;

  return (
    <div className="flex flex-col gap-2" data-testid="qr-field">
      <span className="text-meta text-2">{s.qr}</span>
      {kind === "zelle" && <p className="text-meta text-2">{s.zelleHelp}</p>}
      {value ? (
        <div className={cn("flex gap-4 rounded-lg border border-border bg-surface p-3", choice ? "flex-col" : "items-start")}>
          {choice ?? <QrCode value={value} label={fmt(s.qrImage, { name })} className="size-24" testId="settings-qr" />}
          <div className="flex min-w-0 flex-1 flex-col gap-2">
            <p className="text-meta break-all text-2" data-testid="qr-payload">
              {value}
            </p>
            <div className="flex flex-wrap gap-2">
              <Button type="button" variant="outline" size="sm" onClick={() => fileRef.current?.click()}>
                <ImageUpIcon aria-hidden />
                {s.qrReplace}
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => {
                  onChange(null);
                  setState("idle");
                }}
              >
                <XIcon aria-hidden />
                {s.qrRemove}
              </Button>
            </div>
          </div>
        </div>
      ) : (
        <>
          <div
            data-testid="qr-drop"
            data-over={over || undefined}
            onDragOver={(e) => {
              e.preventDefault();
              setOver(true);
            }}
            onDragLeave={() => setOver(false)}
            onDrop={(e) => {
              e.preventDefault();
              setOver(false);
              const file = [...e.dataTransfer.files].find((f) => f.type.startsWith("image/") || /\.(heic|heif)$/i.test(f.name));
              if (file) void read(file);
              else setState("error");
            }}
            className="flex flex-col items-start gap-2 rounded-lg border border-dashed border-line-strong p-4 transition-colors duration-[120ms] data-[over]:border-primary data-[over]:bg-primary-soft"
          >
            <p className="flex items-center gap-2 text-body font-medium">
              <QrCodeIcon className="size-4 text-2" aria-hidden />
              {s.addQr}
            </p>
            <p className="text-meta text-2">{s.qrDrop}</p>
            <Button type="button" variant="outline" size="sm" onClick={() => fileRef.current?.click()}>
              <ImageUpIcon aria-hidden />
              {s.qrChoose}
            </Button>
          </div>
          <div className="flex gap-2">
            <TextInput
              value={link}
              maxLength={QR_MAX}
              placeholder={s.qrLink}
              aria-label={s.qrLink}
              onChange={(e) => setLink(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && link.trim()) {
                  e.preventDefault();
                  onChange(link.trim());
                  setLink("");
                }
              }}
            />
            <Button
              type="button"
              variant="outline"
              className="h-9 shrink-0"
              disabled={!link.trim()}
              onClick={() => {
                onChange(link.trim());
                setLink("");
                setState("idle");
              }}
            >
              <LinkIcon aria-hidden />
              {s.qrUseLink}
            </Button>
          </div>
          {kind === "zelle" && <p className="text-meta text-2">{s.zelleNoQr}</p>}
          {built && <p className="text-meta text-2">{fmt(s.qrFromLink, { link: linkText(built) })}</p>}
        </>
      )}
      {picker}
      {state === "reading" && (
        <p className="text-meta text-2" aria-live="polite">
          {s.qrReading}
        </p>
      )}
      {state === "error" && (
        <p role="alert" className="flex items-center gap-1.5 text-meta" data-testid="qr-error">
          <CircleAlertIcon className="size-3.5 shrink-0 text-2" aria-hidden />
          {s.qrError}
        </p>
      )}
    </div>
  );
}

/** The screenshot a QR was just read from, kept in memory while the dialog is open (never stored or sent). */
interface Source {
  url: string;
  bitmap: ImageBitmap;
  size: Size;
  /** The first crop: fitted around the QR (and snapped to the card's edges when they are clear). */
  fitted: Rect;
}

/**
 * "Show on statements as": Clean (the QR drawn from its payload) or Original (the user's own crop of the screenshot),
 * side by side as two radio tiles with their previews.
 */
function DisplayChoice({
  value,
  qr,
  name,
  original,
  onClean,
  onOriginal,
  originalRef,
}: {
  value: Draft["display"];
  qr: string;
  name: string;
  original: ReactNode;
  onClean: () => void;
  onOriginal: () => void;
  originalRef: Ref<HTMLInputElement>;
}) {
  const t = useT();
  const s = t.settings.payment;
  const tile = (on: boolean) =>
    cn(
      "flex min-w-0 flex-1 cursor-pointer flex-col items-center gap-2 rounded-lg border p-3 transition-colors duration-[120ms] has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-ring/50",
      on ? "border-primary bg-primary-soft" : "border-border hover:bg-sunken",
    );
  return (
    <fieldset data-testid="qr-display">
      <legend className="mb-2 text-meta text-2">{s.displayAs}</legend>
      <div className="flex gap-3">
        <label className={tile(value === "clean")}>
          <span className="flex h-28 items-center justify-center">
            <QrCode value={qr} label={fmt(s.qrImage, { name })} className="size-24" testId="settings-qr" />
          </span>
          <span className="flex items-center gap-2 text-body">
            <input type="radio" name="qr-display" className="size-4 accent-primary" checked={value === "clean"} onChange={onClean} />
            {s.displayClean}
          </span>
        </label>
        <label className={tile(value === "original")}>
          <span className="flex h-28 w-full items-center justify-center">{original}</span>
          <span className="flex items-center gap-2 text-body">
            <input
              ref={originalRef}
              type="radio"
              name="qr-display"
              className="size-4 accent-primary"
              checked={value === "original"}
              onChange={onOriginal}
              onClick={() => {
                // Choosing Original again (already selected) reopens the crop.
                if (value === "original") onOriginal();
              }}
            />
            {s.displayOriginal}
          </span>
        </label>
      </div>
    </fieldset>
  );
}

/** The add / edit form (md dialog). Saving replaces the whole list; the dialog stays open on an error. */
function MethodDialog({ initial, isNew, onSave }: { initial: Draft; isNew: boolean; onSave: (d: Draft) => Promise<boolean> }) {
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

/**
 * Settings > Profile > Payment methods: the list shown on statements under "My payment details" (at most 6), stored per user
 * through PUT /api/settings/payment-methods. Add or edit in a dialog, reorder with up / down, remove with Undo. Email
 * and phone come from the profile (ProfileContactProvider); rows show the resolved values.
 */
export function PaymentSettings({ initial }: { initial: PaymentMethod[] }) {
  const t = useT();
  const s = t.settings.payment;
  const { contact: profile } = useProfileContact();
  const [methods, setMethods] = useState(initial);
  const [editing, setEditing] = useState<{ index: number | null; key: number } | null>(null);
  const full = methods.length >= PAYMENT_METHODS_MAX;

  const put = async (next: PaymentMethod[]) => {
    const r = await apiFetch<PaymentMethodsSetting>("/settings/payment-methods", { method: "PUT", json: { methods: next } });
    setMethods(r.methods);
    return r.methods;
  };
  const optimistic = async (next: PaymentMethod[]) => {
    const prev = methods;
    setMethods(next);
    try {
      await put(next);
      return true;
    } catch {
      setMethods(prev);
      return false;
    }
  };
  const move = (i: number, delta: -1 | 1) => {
    const next = [...methods];
    [next[i], next[i + delta]] = [next[i + delta]!, next[i]!];
    void optimistic(next);
  };
  const remove = async (i: number) => {
    const prev = methods;
    if (await optimistic(methods.filter((_, j) => j !== i))) {
      toast.success(s.removed, { action: { label: t.common.undo, onClick: () => void put(prev).catch(() => undefined) } });
    }
  };
  const save = async (d: Draft, index: number | null) => {
    const m: PaymentMethod = {
      ...d,
      label: d.label.trim() || null,
      email: d.email.trim() || null,
      phone: d.phone.trim() || null,
      username: d.username.trim() || null,
      text: d.text.trim() || null,
    };
    try {
      await put(index === null ? [...methods, m] : methods.map((x, j) => (j === index ? m : x)));
    } catch {
      return false; // apiFetch showed the error; the dialog stays open
    }
    toast.success(s.saved);
    setEditing(null);
    return true;
  };
  const open = (index: number | null) => setEditing({ index, key: Date.now() });
  const current = editing?.index != null ? methods[editing.index] : undefined;

  return (
    <div className="flex flex-col gap-2" data-testid="payment-methods">
      <h3 className="text-body font-medium">{s.title}</h3>
      <p className="text-body text-2">{s.hint}</p>
      {methods.length > 0 && (
        <ListCard>
          <ul className="divide-y divide-line-soft">
            {methods.map((m, i) => {
              const title = methodTitle(t, m);
              const meta = [...contactSummary(m, profile), m.qr ? (m.display === "original" ? s.qrOriginal : s.qr) : "", m.currencies.join(", "), m.showOnStatement ? "" : s.hidden].filter(Boolean).join(" · ");
              return (
                <li key={i} className="flex min-h-14 items-center gap-3 px-4 py-2.5 md:px-5" data-testid="payment-method">
                  <IconTile icon={paymentKindIcon(m.kind)} />
                  <button type="button" className="min-w-0 flex-1 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring/50" onClick={() => open(i)}>
                    <span className="block truncate text-body font-medium">{title}</span>
                    <span className="flex items-center gap-1 text-meta text-2">
                      {m.qr && <QrCodeIcon className="size-3.5 shrink-0" aria-hidden />}
                      <span className="truncate">{meta}</span>
                    </span>
                  </button>
                  <div className="flex shrink-0 items-center gap-0.5">
                    <Button type="button" variant="ghost" size="icon-sm" aria-label={fmt(s.moveUp, { name: title })} disabled={i === 0} onClick={() => move(i, -1)}>
                      <ArrowUpIcon aria-hidden />
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-sm"
                      aria-label={fmt(s.moveDown, { name: title })}
                      disabled={i === methods.length - 1}
                      onClick={() => move(i, 1)}
                    >
                      <ArrowDownIcon aria-hidden />
                    </Button>
                    <Button type="button" variant="ghost" size="icon-sm" aria-label={fmt(s.edit, { name: title })} onClick={() => open(i)}>
                      <PencilIcon aria-hidden />
                    </Button>
                    <Button type="button" variant="ghost" size="icon-sm" aria-label={fmt(s.remove, { name: title })} onClick={() => void remove(i)}>
                      <Trash2Icon aria-hidden />
                    </Button>
                  </div>
                </li>
              );
            })}
          </ul>
        </ListCard>
      )}
      <div className="flex flex-wrap items-center gap-3">
        <Button type="button" variant="outline" disabled={full} onClick={() => open(null)}>
          <PlusIcon aria-hidden />
          {s.add}
        </Button>
        {full && <span className="text-meta text-2">{s.full}</span>}
      </div>
      <Dialog open={editing !== null} onOpenChange={(o) => !o && setEditing(null)}>
        {editing && (
          <MethodDialog
            key={editing.key}
            isNew={editing.index === null}
            initial={current ? toDraft(current) : blank()}
            onSave={(d) => save(d, editing.index)}
          />
        )}
      </Dialog>
    </div>
  );
}
