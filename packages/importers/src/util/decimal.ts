// Exact decimal strings for quantities, prices and amounts from brokerage sources. Arithmetic goes
// through BigInt; nothing here multiplies or adds floats.

/** A decimal as an integer `units` scaled by 10^-scale: "12.340" → { units: 12340n, scale: 3 }. */
export interface Dec {
  units: bigint;
  scale: number;
}

const DECIMAL_RE = /^([+-]?)(\d*)(?:\.(\d*))?$/;

/** Parses "12", "-0.5", "+1,234.5678", ".25"; throws on anything else (no exponents, no NaN). */
export function parseDec(input: string): Dec {
  const s = input.trim().replace(/,/g, "");
  const m = DECIMAL_RE.exec(s);
  if (!m || (m[2] === "" && (m[3] ?? "") === "")) throw new Error(`invalid decimal: ${JSON.stringify(input)}`);
  const frac = m[3] ?? "";
  const units = BigInt((m[2] || "0") + frac);
  return { units: m[1] === "-" ? -units : units, scale: frac.length };
}

/** Canonical text: no plus sign, no leading zeros, trailing fractional zeros removed ("-0" → "0"). */
export function formatDec(d: Dec): string {
  let { units, scale } = d;
  while (scale > 0 && units % 10n === 0n) {
    units /= 10n;
    scale -= 1;
  }
  const neg = units < 0n;
  const digits = (neg ? -units : units).toString().padStart(scale + 1, "0");
  const whole = digits.slice(0, digits.length - scale);
  const frac = scale > 0 ? `.${digits.slice(digits.length - scale)}` : "";
  return `${neg && units !== 0n ? "-" : ""}${whole}${frac}`;
}

/** Validates and canonicalizes a decimal string ("0010.500" → "10.5"). */
export function normalizeDecimal(input: string): string {
  return formatDec(parseDec(input));
}

/**
 * A JSON number (Plaid sends quantities and prices as doubles) as the shortest decimal string that
 * round-trips to the same double, which is the text Plaid sent for any value with up to 15 to 17
 * significant digits. Exponent forms (1e-7) are expanded.
 */
export function numberToDecimal(n: number): string {
  if (!Number.isFinite(n)) throw new Error(`not a finite number: ${n}`);
  const s = String(n);
  const m = /^(-?)(\d)(?:\.(\d+))?e([+-]\d+)$/.exec(s);
  if (!m) return normalizeDecimal(s);
  const digits = m[2]! + (m[3] ?? "");
  const exp = Number(m[4]);
  // value = 0.digits × 10^(exp + 1)
  const point = exp + 1;
  const body =
    point <= 0 ? `0.${"0".repeat(-point)}${digits}`
    : point >= digits.length ? digits + "0".repeat(point - digits.length)
    : `${digits.slice(0, point)}.${digits.slice(point)}`;
  return normalizeDecimal(m[1] + body);
}

function pow10(n: number): bigint {
  return 10n ** BigInt(n);
}

export function addDec(a: Dec, b: Dec): Dec {
  const scale = Math.max(a.scale, b.scale);
  return { units: a.units * pow10(scale - a.scale) + b.units * pow10(scale - b.scale), scale };
}

export function mulDec(a: Dec, b: Dec): Dec {
  return { units: a.units * b.units, scale: a.scale + b.scale };
}

/** Integer division rounding half away from zero. */
export function divRound(n: bigint, d: bigint): bigint {
  if (d === 0n) throw new Error("division by zero");
  const neg = n < 0n !== d < 0n;
  const an = n < 0n ? -n : n;
  const ad = d < 0n ? -d : d;
  const q = (an * 2n + ad) / (ad * 2n);
  return neg ? -q : q;
}

function toSafeNumber(v: bigint, what: string): number {
  if (v > BigInt(Number.MAX_SAFE_INTEGER) || v < -BigInt(Number.MAX_SAFE_INTEGER)) throw new Error(`${what} out of range: ${v}`);
  return Number(v);
}

/** Decimal to integer minor units (digits = 2 for cents), rounding half away from zero once. */
export function decToMinor(d: Dec, digits = 2): number {
  const units = d.scale <= digits ? d.units * pow10(digits - d.scale) : divRound(d.units, pow10(d.scale - digits));
  return toSafeNumber(units === 0n ? 0n : units, "minor amount");
}

/** "1234.5678" → 123457 (digits 2). */
export function decimalToMinor(input: string, digits = 2): number {
  return decToMinor(parseDec(input), digits);
}

/** Product of decimal strings in minor units with a single rounding step: quantity × price × multiplier. */
export function productToMinor(factors: string[], digits = 2): number {
  return decToMinor(factors.map(parseDec).reduce(mulDec, { units: 1n, scale: 0 }), digits);
}

/** Integer minor units back to a decimal string ("-12345", 2 → "-123.45"). */
export function minorToDecimal(minor: number, digits = 2): string {
  return formatDec({ units: BigInt(minor), scale: digits });
}
