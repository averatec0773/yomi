import {
  defaultPaymentCurrencies,
  isLegacyContact,
  isPaymentKind,
  PAYMENT_METHODS_MAX,
  type PaymentContact,
  type PaymentMethod,
  type PaymentOriginal,
  type ProfileContact,
  type ProfileFlags,
  profileFields,
  type StoredPaymentMethod,
  upgradeHandle,
  upgradeToProfile,
} from "../payment";
import { upgradePhone } from "../phone";
import type { CurrentUser } from "../user";
import { deleteSetting, type Q, readSetting, writeSetting } from "./store";

const PAYMENT_METHODS_KEY = "payment_methods";
/**
 * Settings > Profile's email and phone, one row each (the phone as E.164; one typed before v0.1.30 is read through
 * `upgradePhone` and written back on the next save); payment methods show them.
 */
const PROFILE_KEYS = { email: "profile_email", phone: "profile_phone" } as const;
const PROFILE_MAX = { email: 200, phone: 40 } as const;

const text = (v: unknown): string => (typeof v === "string" ? v.trim() : "");
const orNull = (v: unknown): string | null => text(v) || null;

const ORIGINAL_DATA_URL = /^data:image\/(webp|png);base64,[A-Za-z0-9+/]+={0,2}$/;
const dimension = (v: unknown, max: number): v is number => typeof v === "number" && Number.isInteger(v) && v >= 1 && v <= max;

/** A stored original image, or null when it is missing or does not read as a WebP / PNG data URL with its size. */
function readOriginal(v: unknown): PaymentOriginal | null {
  if (!v || typeof v !== "object") return null;
  const o = v as Record<string, unknown>;
  if (typeof o.dataUrl !== "string" || !ORIGINAL_DATA_URL.test(o.dataUrl)) return null;
  if (!dimension(o.width, 600) || !dimension(o.height, 2400)) return null;
  return { dataUrl: o.dataUrl, width: o.width, height: o.height };
}

/**
 * One stored entry, or null when it is not a usable method (unknown kind, no contact value, no profile flag and no
 * QR). Entries saved before v0.1.26 carry one `handle`; it is moved to the field its kind shows (`upgradeHandle`).
 * Entries saved before v0.1.27 have no `original` and read as `display: "clean"`; an original without a QR payload is
 * dropped, and "original" without an image reads as "clean". Entries saved before v0.1.29 have no profile flags and
 * come back without them (`isLegacyContact`); a flag is kept only for a field the kind shows and while the method has
 * no own value there. A phone saved before v0.1.30 reads as E.164 when it is a valid number (`upgradePhone`), else as
 * typed.
 */
function readMethod(v: unknown): StoredPaymentMethod | null {
  if (!v || typeof v !== "object") return null;
  const o = v as Record<string, unknown>;
  if (!isPaymentKind(o.kind)) return null;
  const contact: PaymentContact = { email: orNull(o.email), phone: orNull(o.phone), username: orNull(o.username), text: orNull(o.text) };
  const legacy = text(o.handle);
  if (legacy && !contact.email && !contact.phone && !contact.username && !contact.text) Object.assign(contact, upgradeHandle(o.kind, legacy));
  if (contact.phone) contact.phone = upgradePhone(contact.phone);
  const qr = text(o.qr) || null;
  const beforeFlags = o.useProfileEmail === undefined && o.useProfilePhone === undefined;
  const flags: Partial<ProfileFlags> = beforeFlags
    ? {}
    : {
        useProfileEmail: o.useProfileEmail === true && !contact.email && profileFields(o.kind).includes("email"),
        useProfilePhone: o.useProfilePhone === true && !contact.phone && profileFields(o.kind).includes("phone"),
      };
  if (!contact.email && !contact.phone && !contact.username && !contact.text && !flags.useProfileEmail && !flags.useProfilePhone && !qr) return null;
  const original = qr ? readOriginal(o.original) : null;
  const currencies = Array.isArray(o.currencies) ? [...new Set(o.currencies.filter((c): c is string => typeof c === "string" && /^[A-Z]{3}$/.test(c)))] : [];
  return {
    kind: o.kind,
    label: text(o.label) || null,
    ...contact,
    ...flags,
    qr,
    original,
    display: o.display === "original" && original ? "original" : "clean",
    currencies: currencies.length > 0 ? currencies : defaultPaymentCurrencies(o.kind),
    showOnStatement: o.showOnStatement !== false,
  };
}

/** The stored entries in display order (at most PAYMENT_METHODS_MAX), without the profile upgrade. */
async function readStored(q: Q, user: CurrentUser): Promise<StoredPaymentMethod[]> {
  const raw = await readSetting(q, user, PAYMENT_METHODS_KEY);
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map(readMethod)
      .filter((m): m is StoredPaymentMethod => m !== null)
      .slice(0, PAYMENT_METHODS_MAX);
  } catch {
    return [];
  }
}

async function writeMethods(q: Q, user: CurrentUser, methods: readonly PaymentMethod[]): Promise<void> {
  if (methods.length === 0) await deleteSetting(q, user, PAYMENT_METHODS_KEY);
  else await writeSetting(q, user, PAYMENT_METHODS_KEY, JSON.stringify(methods));
}

const normalizeContact = (f: keyof ProfileContact, v: string | null | undefined): string | null => (v ?? "").trim().slice(0, PROFILE_MAX[f]).trim() || null;

async function readProfile(q: Q, user: CurrentUser): Promise<ProfileContact> {
  return {
    email: normalizeContact("email", await readSetting(q, user, PROFILE_KEYS.email)),
    phone: normalizeContact("phone", upgradePhone(await readSetting(q, user, PROFILE_KEYS.phone) ?? "")),
  };
}

async function writeProfile(q: Q, user: CurrentUser, contact: ProfileContact): Promise<void> {
  for (const f of ["email", "phone"] as const) {
    const v = normalizeContact(f, contact[f]);
    if (v === null) await deleteSetting(q, user, PROFILE_KEYS[f]);
    else await writeSetting(q, user, PROFILE_KEYS[f], v);
  }
}

/**
 * The profile contact and the methods, after the v0.1.29 upgrade (`upgradeToProfile`): while any stored method
 * predates the profile flags, the upgrade runs and both are written back at once, so it happens exactly once and the
 * methods' email and phone end up referencing the profile.
 */
async function readContacts(q: Q, user: CurrentUser): Promise<{ profile: ProfileContact; methods: PaymentMethod[] }> {
  const stored = await readStored(q, user);
  const profile = await readProfile(q, user);
  if (!stored.some(isLegacyContact)) return upgradeToProfile(profile, stored);
  const up = upgradeToProfile(profile, stored);
  await writeProfile(q, user, up.profile);
  await writeMethods(q, user, up.methods);
  return up;
}

/**
 * The user's payment methods in display order, stored as one JSON array under `payment_methods`. Entries that do not
 * read as a method are skipped; at most PAYMENT_METHODS_MAX. `email` and `phone` are each method's own values (see
 * `resolveContact` for what statements show). Validation of new values is @yomi/contracts' PaymentMethodInput.
 */
export async function getPaymentMethods(q: Q, user: CurrentUser): Promise<PaymentMethod[]> {
  return (await readContacts(q, user)).methods;
}

/** Replaces the list; an empty list removes the row. Missing profile flags read as off. Returns what is stored now. */
export async function setPaymentMethods(
  q: Q,
  user: CurrentUser,
  methods: readonly (Omit<PaymentMethod, keyof ProfileFlags> & Partial<ProfileFlags>)[],
): Promise<PaymentMethod[]> {
  await readContacts(q, user);
  const clean = methods
    .map((m) => readMethod({ useProfileEmail: false, useProfilePhone: false, ...m }))
    .filter((m): m is StoredPaymentMethod => m !== null)
    .slice(0, PAYMENT_METHODS_MAX)
    .map((m) => ({ ...m, useProfileEmail: m.useProfileEmail ?? false, useProfilePhone: m.useProfilePhone ?? false }));
  await writeMethods(q, user, clean);
  return await getPaymentMethods(q, user);
}

/** Settings > Profile's email and phone (null when unset), after the v0.1.29 upgrade. */
export async function getProfileContact(q: Q, user: CurrentUser): Promise<ProfileContact> {
  return (await readContacts(q, user)).profile;
}

/** Changes the fields given (trimmed; empty or null removes the row). Returns what is stored now. */
export async function setProfileContact(q: Q, user: CurrentUser, patch: Partial<ProfileContact>): Promise<ProfileContact> {
  const current = await getProfileContact(q, user);
  await writeProfile(q, user, { ...current, ...patch });
  return await getProfileContact(q, user);
}
