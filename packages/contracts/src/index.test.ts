import { describe, expect, it } from "vitest";
import { Money } from "./index";

describe("Money", () => {
  it("accepts integer minor units with an ISO currency", () => {
    expect(Money.parse({ amountMinor: -1234, currency: "CNY" })).toEqual({ amountMinor: -1234, currency: "CNY" });
  });

  it("rejects floats and bad currencies", () => {
    expect(Money.safeParse({ amountMinor: 12.34, currency: "CNY" }).success).toBe(false);
    expect(Money.safeParse({ amountMinor: 1, currency: "rmb" }).success).toBe(false);
  });
});
