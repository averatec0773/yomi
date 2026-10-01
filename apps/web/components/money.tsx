import { formatMinor } from "@yomi/core/money";
import { cn } from "@/lib/utils";

export type MoneySign = "plain" | "signed" | "inflow";

export interface MoneyProps {
  /** Integer minor units (fen / cents). Never a float. */
  minor: number;
  currency: string;
  /**
   * plain: "-" only when negative (default).
   * signed: always "+" or "-" (zero has none).
   * inflow: amounts > 0 get "+" and text-pos; everything else renders plain in text color.
   */
  sign?: MoneySign;
  /** Force a tone, e.g. "neg" for "You pay Li" on Split and settle. Overrides the inflow color. */
  tone?: "default" | "pos" | "neg" | "muted";
  /** Show the absolute value (the sentence around it carries the direction). */
  abs?: boolean;
  /** Append the ISO code in text-3, for when CNY and USD appear together. */
  showCode?: boolean;
  className?: string;
}

/** Splits formatMinor output into symbol prefix ("¥", "HK$", "XYZ ") and digits. */
function splitSymbol(formatted: string): { symbol: string; digits: string } {
  const i = formatted.search(/\d/);
  return i <= 0 ? { symbol: "", digits: formatted } : { symbol: formatted.slice(0, i), digits: formatted.slice(i) };
}

/**
 * Money from integer minor units through core `formatMinor`. Tabular numerals, symbol smaller in text-2.
 * Inherits font size, so wrap it (or pass className) for text-total / text-hero.
 */
export function Money({ minor, currency, sign = "plain", tone, abs = false, showCode = false, className }: MoneyProps) {
  const value = abs ? Math.abs(minor) : minor;
  const { symbol, digits } = splitSymbol(formatMinor(Math.abs(value), currency));
  let prefix = "";
  if (value < 0) prefix = "-";
  else if (value > 0 && (sign === "signed" || sign === "inflow")) prefix = "+";
  const resolved = tone ?? (sign === "inflow" && value > 0 ? "pos" : "default");

  return (
    <span
      className={cn(
        "num inline-flex items-baseline justify-end",
        resolved === "pos" && "text-pos",
        resolved === "neg" && "text-neg",
        resolved === "muted" && "text-2",
        className,
      )}
    >
      {prefix && <span>{prefix === "-" ? "−" : "+"}</span>}
      {symbol && <span className={cn(symbol.endsWith(" ") ? "mr-1" : "mr-px", "text-[0.85em]", resolved === "default" && "text-2")}>{symbol.trim()}</span>}
      <span>{digits}</span>
      {showCode && <span className="ml-1 font-sans text-[0.75em] text-3">{currency.toUpperCase()}</span>}
    </span>
  );
}

/** Plain-string version for toasts, titles and aria labels. */
export function moneyText(minor: number, currency: string): string {
  return formatMinor(minor, currency);
}
