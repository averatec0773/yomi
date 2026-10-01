import { disconnectConfirmMatches, disconnectConfirmText } from "@yomi/contracts";
import { describe, expect, it } from "vitest";

describe("disconnect confirmation", () => {
  it("matches the institution name exactly, case-sensitive, after trimming what was typed", () => {
    expect(disconnectConfirmMatches("Bank of America", "Bank of America")).toBe(true);
    expect(disconnectConfirmMatches("Bank of America", "  Bank of America\n")).toBe(true);
    for (const typed of ["", "bank of america", "BANK OF AMERICA", "Bank of  America", "Bank of Americ", "Bank of America.", null, undefined]) {
      expect(disconnectConfirmMatches("Bank of America", typed)).toBe(false);
    }
  });

  it('falls back to "bank" when Plaid gave no institution name', () => {
    expect(disconnectConfirmText(null)).toBe("bank");
    expect(disconnectConfirmText("  ")).toBe("bank");
    expect(disconnectConfirmMatches(null, "bank")).toBe(true);
    expect(disconnectConfirmMatches(null, "")).toBe(false);
  });
});
