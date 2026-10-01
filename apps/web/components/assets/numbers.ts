/** Calm sign tone for a gain or loss: moss above zero (money coming in), plain otherwise with its "−" sign. Clay is only for "You pay X". */
export function pnlTone(minor: number): "pos" | "default" {
  return minor > 0 ? "pos" : "default";
}

/** A position's share of its currency's market value, one decimal ("12.3%"), from integers only. "—" when the total is not positive. */
export function weightText(minor: number, totalMinor: number): string {
  if (!(totalMinor > 0)) return "—";
  const permille = Math.round((minor * 1000) / totalMinor);
  const sign = permille < 0 ? "-" : "";
  const v = Math.abs(permille);
  return `${sign}${Math.floor(v / 10)}.${v % 10}%`;
}
