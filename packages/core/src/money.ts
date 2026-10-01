// Money helpers. Amounts are integer minor units; parsing never goes through floats.

const MINOR_DIGITS: Record<string, number> = { JPY: 0, KRW: 0 };
const SYMBOLS: Record<string, string> = { CNY: "¥", USD: "$", HKD: "HK$", EUR: "€", GBP: "£", JPY: "JP¥" };

export function minorDigits(currency: string): number {
  return MINOR_DIGITS[currency.toUpperCase()] ?? 2;
}

function assertSafeInt(n: number, what: string): void {
  if (!Number.isSafeInteger(n)) throw new Error(`${what} must be a safe integer, got ${n}`);
}

function groupThousands(digits: string): string {
  return digits.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

/** formatMinor(-123456, "CNY") → "-¥1,234.56". Unknown currencies get a code prefix. */
export function formatMinor(minor: number, currency: string): string {
  assertSafeInt(minor, "minor");
  const code = currency.toUpperCase();
  const digits = minorDigits(code);
  const abs = String(Math.abs(minor)).padStart(digits + 1, "0");
  const whole = groupThousands(abs.slice(0, abs.length - digits));
  const frac = digits > 0 ? "." + abs.slice(abs.length - digits) : "";
  const symbol = SYMBOLS[code];
  const body = symbol ? `${symbol}${whole}${frac}` : `${code} ${whole}${frac}`;
  return minor < 0 ? `-${body}` : body;
}

/** formatMinorDecimal(-123456, "CNY") → "-1234.56": no symbol, no grouping (for CSV). */
export function formatMinorDecimal(minor: number, currency: string): string {
  assertSafeInt(minor, "minor");
  const digits = minorDigits(currency);
  const abs = String(Math.abs(minor)).padStart(digits + 1, "0");
  const whole = abs.slice(0, abs.length - digits);
  const frac = digits > 0 ? "." + abs.slice(abs.length - digits) : "";
  return `${minor < 0 ? "-" : ""}${whole}${frac}`;
}

/**
 * Parses a decimal amount string into integer minor units with string arithmetic only.
 * Accepts an optional sign, currency symbol/code, thousands commas and surrounding spaces:
 * "12", "-12.5", "¥1,234.56", "$0.07", "USD 3.10". Extra decimal digits must be zeros.
 */
export function parseAmountToMinor(input: string, digits = 2): number {
  let s = input.trim().replace(/[\s,]/g, "");
  let negative = false;
  if (s.startsWith("-") || s.startsWith("+")) {
    negative = s[0] === "-";
    s = s.slice(1);
  }
  s = s.replace(/^(?:[A-Za-z]{3}|HK\$|US\$|[¥￥$€£])/, "");
  if (!negative && (s.startsWith("-") || s.startsWith("+"))) {
    negative = s[0] === "-";
    s = s.slice(1);
  }
  const m = /^(\d+)(?:\.(\d*))?$|^\.(\d+)$/.exec(s);
  if (!m) throw new Error(`invalid amount: ${JSON.stringify(input)}`);
  const whole = m[1] ?? "0";
  let frac = m[2] ?? m[3] ?? "";
  if (frac.length > digits) {
    if (/[^0]/.test(frac.slice(digits))) throw new Error(`too many decimal places: ${JSON.stringify(input)}`);
    frac = frac.slice(0, digits);
  }
  const text = (whole + frac.padEnd(digits, "0")).replace(/^0+(?=\d)/, "");
  const value = Number(text);
  assertSafeInt(value, "amount");
  return negative && value !== 0 ? -value : value;
}

/**
 * Splits `totalMinor` into `n` integer shares: each gets floor(|total|/n), the remainder goes to
 * index 0 (the "me" row). The sign of the total is applied to every share; shares sum to total.
 */
export function splitEqual(totalMinor: number, n: number): number[] {
  assertSafeInt(totalMinor, "totalMinor");
  if (!Number.isInteger(n) || n < 1) throw new Error(`n must be a positive integer, got ${n}`);
  const sign = totalMinor < 0 ? -1 : 1;
  const abs = Math.abs(totalMinor);
  const base = Math.floor(abs / n);
  const remainder = abs - base * n;
  return Array.from({ length: n }, (_, i) => sign * (i === 0 ? base + remainder : base) || 0);
}

// FX between two currencies. A rate is a decimal string: units of the other ("original") currency per 1 unit of
// the base currency, e.g. "7.2" CNY per 1 USD. Arithmetic runs on BigInt fractions; each conversion rounds once,
// half away from zero, into the target's minor units.

/** Decimal places kept when a rate is derived from two amounts. */
export const FX_RATE_DECIMALS = 8;

const RATE_RE = /^(\d{1,12})(?:\.(\d{1,12}))?$/;

/** Trims and validates a positive decimal rate ("7.20" → "7.2"); null when invalid or zero. */
export function normalizeRate(input: string): string | null {
  const s = input.trim().replace(/,/g, "");
  const m = RATE_RE.exec(s.startsWith(".") ? `0${s}` : s);
  if (!m) return null;
  const whole = m[1]!.replace(/^0+(?=\d)/, "");
  const frac = (m[2] ?? "").replace(/0+$/, "");
  if (/^0*$/.test(whole + frac)) return null;
  return frac ? `${whole}.${frac}` : whole;
}

function rateFraction(rate: string): { num: bigint; den: bigint } {
  const r = normalizeRate(rate);
  if (r === null) throw new Error(`invalid rate: ${JSON.stringify(rate)}`);
  const [w, f = ""] = r.split(".");
  return { num: BigInt(w! + f), den: 10n ** BigInt(f.length) };
}

/** round(x / y), half away from zero; y > 0. */
function divRound(x: bigint, y: bigint): bigint {
  const neg = x < 0n;
  const ax = neg ? -x : x;
  const q = (2n * ax + y) / (2n * y);
  return neg ? -q : q;
}

function toSafeNumber(v: bigint): number {
  const n = Number(v);
  assertSafeInt(n, "converted amount");
  return n === 0 ? 0 : n;
}

/** Base amount × rate, in the other currency's minor units: convertByRate(5000, "USD", "7.2", "CNY") → 36000. */
export function convertByRate(baseMinor: number, baseCurrency: string, rate: string, otherCurrency: string): number {
  assertSafeInt(baseMinor, "baseMinor");
  const { num, den } = rateFraction(rate);
  const x = BigInt(baseMinor) * num * 10n ** BigInt(minorDigits(otherCurrency));
  return toSafeNumber(divRound(x, den * 10n ** BigInt(minorDigits(baseCurrency))));
}

/** The inverse: other amount ÷ rate, in the base currency's minor units: convertFromRate(36000, "CNY", "7.2", "USD") → 5000. */
export function convertFromRate(otherMinor: number, otherCurrency: string, rate: string, baseCurrency: string): number {
  assertSafeInt(otherMinor, "otherMinor");
  const { num, den } = rateFraction(rate);
  const x = BigInt(otherMinor) * den * 10n ** BigInt(minorDigits(baseCurrency));
  return toSafeNumber(divRound(x, num * 10n ** BigInt(minorDigits(otherCurrency))));
}

/** Rate implied by two amounts (other per 1 base): at least FX_RATE_DECIMALS places, more when needed to convert back exactly; trailing zeros trimmed; null when either is zero. */
export function rateFromAmounts(baseMinor: number, baseCurrency: string, otherMinor: number, otherCurrency: string): string | null {
  assertSafeInt(baseMinor, "baseMinor");
  assertSafeInt(otherMinor, "otherMinor");
  const a = BigInt(Math.abs(baseMinor));
  const b = BigInt(Math.abs(otherMinor));
  if (a === 0n || b === 0n) return null;
  // Enough places that base × rate rounds back to exactly `otherMinor` (the error stays under half a minor unit).
  const places = Math.min(12, Math.max(FX_RATE_DECIMALS, a.toString().length + minorDigits(otherCurrency) - minorDigits(baseCurrency)));
  const scaled = divRound(b * 10n ** BigInt(minorDigits(baseCurrency) + places), a * 10n ** BigInt(minorDigits(otherCurrency)));
  if (scaled === 0n) return null;
  const digits = scaled.toString().padStart(places + 1, "0");
  const whole = digits.slice(0, digits.length - places);
  const frac = digits.slice(digits.length - places).replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : whole;
}
