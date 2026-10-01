/**
 * Phone numbers (Settings > Profile's phone and a payment method's "Use a different number"): stored as E.164
 * ("+12025550143"), the country derived from it. Pure helpers over libphonenumber-js (min metadata), importable on the
 * client as `@yomi/core/phone`. The contract check is @yomi/contracts' `optionalPhone`.
 */

import { AsYouType, type CountryCode, getCountries, getCountryCallingCode, parsePhoneNumberFromString } from "libphonenumber-js/min";

export type { CountryCode };
export { getCountries, getCountryCallingCode };

/** Offered first in the country picker, in this order. */
export const PINNED_COUNTRIES: readonly CountryCode[] = ["US", "CN"];
export const DEFAULT_PHONE_COUNTRY: CountryCode = "US";

export interface ParsedPhone {
  /** "+12025550143" */
  e164: string;
  /** Undefined for a valid number the metadata cannot place in one country (rare). */
  country: CountryCode | undefined;
  /** Digits after the calling code: "2025550143". */
  nationalNumber: string;
}

/**
 * `value` as a valid phone number, or null: with a leading "+" it is read as international, otherwise as a national
 * number of `country` (default US).
 */
export function parsePhone(value: string, country: CountryCode = DEFAULT_PHONE_COUNTRY): ParsedPhone | null {
  const p = parsePhoneNumberFromString(value.trim(), country);
  if (!p || !p.isValid()) return null;
  return { e164: p.number, country: p.country, nationalNumber: p.nationalNumber };
}

/** True for a value stored as a valid E.164 number (what the phone input saves). */
export function isE164Phone(value: string): boolean {
  const t = value.trim();
  return /^\+\d+$/.test(t) && parsePhone(t) !== null;
}

/**
 * A phone stored before v0.1.30 (typed freely) read as E.164: without a "+" it is read as a US number. A value that
 * does not read as a valid number is kept as typed (trimmed); Settings shows it with "Check this number", and nothing
 * is written back until the next save.
 */
export function upgradePhone(stored: string): string {
  const t = stored.trim();
  return parsePhone(t)?.e164 ?? t;
}

/** "(202) 555-0143" as US numbers are usually written: "202-555-0143"; also "1 (202) 555" while typing. */
function usStyle(text: string): string {
  return text.replace(/^(1 )?\((\d{3})\)( ?)/, (_m, one: string | undefined, area: string, space: string) => `${one ?? ""}${area}${space ? "-" : ""}`);
}

/**
 * A phone for reading. US numbers in national style, "202-555-0143", with "+1 " before it when `currency` is given
 * and is not USD (a statement whose reader may be abroad); China "+86 138 0013 8000"; every other country in
 * international format. A value that is not a valid number shows as typed.
 */
export function formatPhone(value: string, opts: { currency?: string } = {}): string {
  const t = value.trim();
  const p = parsePhoneNumberFromString(t, DEFAULT_PHONE_COUNTRY);
  if (!p || !p.isValid()) return t;
  if (p.country === "US") {
    const n = p.nationalNumber;
    const national = `${n.slice(0, 3)}-${n.slice(3, 6)}-${n.slice(6)}`;
    return opts.currency && opts.currency !== "USD" ? `+1 ${national}` : national;
  }
  return p.formatInternational();
}

/** A `tel:` link in E.164, or null when the value is not a valid number. */
export function phoneHref(value: string): string | null {
  const p = parsePhone(value);
  return p ? `tel:${p.e164}` : null;
}

/** The country a new phone defaults to from the user's time zone: America/* the US, Asia/Shanghai China, else US. */
export function countryForTimeZone(timeZone: string | null | undefined): CountryCode {
  if (timeZone === "Asia/Shanghai" || timeZone === "PRC") return "CN";
  return DEFAULT_PHONE_COUNTRY;
}

/** The picker's country for a stored value: the number's own, else the time zone's (`countryForTimeZone`). */
export function phoneCountry(value: string | null | undefined, timeZone: string | null | undefined): CountryCode {
  return (value ? parsePhone(value)?.country : undefined) ?? countryForTimeZone(timeZone);
}

const digitsOf = (text: string) => text.replace(/\D/g, "");

/**
 * National digits formatted as typed for `country`: US in "202-555-0143" style; digits typed with the national
 * prefix ("020 …") as a national number; anything else grouped as the international format groups it, without the
 * calling code ("20 7946 0958", "138 0013 8000").
 */
export function formatNationalTyping(digits: string, country: CountryCode): string {
  const d = digitsOf(digits);
  if (!d) return "";
  if (country === "US") return usStyle(new AsYouType(country).input(d));
  if (d.startsWith("0")) return new AsYouType(country).input(d);
  const code = getCountryCallingCode(country);
  return new AsYouType(country).input(`+${code}${d}`).replace(new RegExp(`^\\+${code}\\s?`), "");
}

/**
 * What the number field shows after an edit, and the picker's country. A value starting with "+" (typed or pasted)
 * switches the country once the calling code and digits name one, and the field keeps the national part; until then it
 * shows the international text as typed. Anything else is formatted as a national number of `country`.
 */
export function typePhone(input: string, country: CountryCode): { text: string; country: CountryCode } {
  const t = input.trim();
  if (t.startsWith("+")) {
    const typing = new AsYouType();
    const intl = typing.input(t);
    const found = typing.getCountry();
    const callingCode = typing.getCallingCode();
    if (found && callingCode) return { text: formatNationalTyping(digitsOf(t).slice(callingCode.length), found), country: found };
    return { text: intl, country };
  }
  return { text: formatNationalTyping(t, country), country };
}

/** The number field's text for a stored value: national for its country, or the raw text when it is not a valid number. */
export function phoneFieldText(value: string | null | undefined): string {
  if (!value) return "";
  const p = parsePhone(value);
  if (!p || !p.country) return value.trim();
  return formatNationalTyping(p.nationalNumber, p.country);
}
