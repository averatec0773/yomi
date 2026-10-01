import { describe, expect, it } from "vitest";
import { cleanMerchant } from "./merchant";

describe("cleanMerchant", () => {
  it.each([
    ["TST* GOLDEN BOWL NOODLE", "Golden Bowl Noodle"],
    ["SQ *BLUE BOTTLE COFFEE", "Blue Bottle Coffee"],
    ["SP  ACME SOCKS", "Acme Socks"],
    ["UEP*SUNNY MART", "Sunny Mart"],
    ["PAYPAL *STEAMGAMES", "Steamgames"],
    ["LinkedIn*P3037300946", "LinkedIn"],
    ["WAL-MART #1234 SAN JOSE CA", "Wal-Mart"],
    ["KROGER 00123 COLUMBUS OH", "Kroger"],
    ["NETFLIX.COM   CA", "Netflix.com"],
    ["MCDONALD'S F12345", "Mcdonald's F12345"],
    ["  H   MART  ", "H Mart"],
    ["Nintendo CC1610834036", "Nintendo"],
    ["STEAM PURCHASE CC99", "Steam Purchase"],
    ["ACME AIRLINES 0062312345678", "Acme Airlines"],
    ["PAYPAL SVC REF7788991122", "Paypal Svc"],
    ["Weee! Inc Fremont", "Weee!"],
    ["Freshdish Inc New York", "Freshdish"],
    ["Amazon Mktpl", "Amazon"],
    ["WEEE! INC FREMONT CA", "Weee!"],
    ["Acme Widgets, LLC", "Acme Widgets"],
    ["Blue Bottle Coffee Co. San Francisco CA", "Blue Bottle Coffee"],
    ["Foo Corp", "Foo"],
    ["ACME CLOUD PTE. LTD.", "Acme Cloud"],
    ["1-800 WIDGETS, INC.", "1-800 Widgets"],
    ["Bar Ltd South San Francisco", "Bar"],
    ["H-E-B", "H-E-B"],
    ["99 Ranch", "99 Ranch"],
    ["99 RANCH MARKET #123 SAN JOSE CA", "99 Ranch Market"],
    ["Busy Bee Cafe", "Busy Bee Cafe"],
    ["Co Op Market", "Co Op Market"],
    ["海底捞火锅(某某店)", "海底捞火锅(某某店)"],
    ["  张 三 ", "张 三"],
    ["", ""],
  ])("%s → %s", (input, expected) => {
    expect(cleanMerchant(input)).toBe(expected);
  });

  it("never returns empty for non-empty input", () => {
    expect(cleanMerchant("#123")).toBe("#123");
  });
});
