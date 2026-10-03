import {
  AssetsError,
  BankProviderError,
  BankSyncError,
  CaptureError,
  ImportError,
  InvestError,
  LedgerError,
  SecretKeyError,
  SplitError,
} from "@yomi/core";
import { describe, expect, it } from "vitest";
import { errorBody, statusOf } from "./errors";

describe("statusOf", () => {
  it("maps every module's errors by kind, so the same condition gets the same status everywhere", () => {
    const cases: [Parameters<typeof statusOf>[0], number][] = [
      [new SplitError("invalid", "split_x", "x"), 400],
      [new LedgerError("invalid", "category_kind_mismatch", "x"), 400],
      [new LedgerError("forbidden", "system_category", "x"), 403],
      [new CaptureError("not_found", "capture_not_found", "x"), 404],
      [new CaptureError("conflict", "capture_not_open", "x"), 409],
      [new ImportError("conflict", "import_already_imported", "x"), 409],
      [new BankSyncError("not_found", "bank_connection_not_found", "x"), 404],
      [new AssetsError("invalid", "assets_invalid_date", "x"), 400],
      [new SecretKeyError("missing"), 409],
      [new InvestError("invest_ibkr_rate_limited", "x"), 429],
      [new InvestError("invest_ibkr_test_timeout", "x"), 504],
      [new BankProviderError("reconnect", "ITEM_LOGIN_REQUIRED"), 409],
      [new BankProviderError("other", "boom"), 502],
    ];
    expect(cases.map(([e]) => statusOf(e))).toEqual(cases.map(([, s]) => s));
  });

  it("answers with the code and params the UI translates", () => {
    expect(errorBody(new BankProviderError("rate_limited", "slow down"))).toEqual({
      error: "slow down",
      code: "bank_provider_rate_limited",
      params: { detail: "slow down" },
    });
  });
});
