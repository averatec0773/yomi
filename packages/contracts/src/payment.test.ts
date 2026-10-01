import { describe, expect, it } from "vitest";
import {
  dataUrlBytes,
  defaultPaymentCurrencies,
  PAYMENT_KINDS,
  PAYMENT_ORIGINAL_MAX_BYTES,
  PaymentMethodInput,
  SetPaymentMethodsInput,
} from "./payment";
import { DEFAULT_STATEMENT_FLAGS, StatementQuery } from "./split";

describe("payment methods contract", () => {
  it("defaults the currencies by kind and trims text", () => {
    const zelle = PaymentMethodInput.parse({ kind: "zelle", email: " alex@example.com ", phone: " +1 555 010 0100 ", label: "  " });
    expect(zelle).toEqual({
      kind: "zelle",
      label: null,
      email: "alex@example.com",
      phone: "+1 555 010 0100",
      username: null,
      text: null,
      useProfileEmail: false,
      useProfilePhone: false,
      qr: null,
      original: null,
      display: "clean",
      currencies: ["USD"],
      showOnStatement: true,
    });
    for (const kind of ["venmo", "paypal", "cashapp", "other"] as const) expect(PaymentMethodInput.parse({ kind, username: "x" }).currencies).toEqual(["USD"]);
    for (const kind of ["alipay", "wechat"] as const) expect(PaymentMethodInput.parse({ kind, text: "x" }).currencies).toEqual(["CNY"]);
    expect(PAYMENT_KINDS.map(defaultPaymentCurrencies).flat()).toEqual(["USD", "USD", "USD", "USD", "CNY", "CNY", "USD"]);
    // Given currencies are kept (deduplicated), and showOnStatement can be off.
    expect(PaymentMethodInput.parse({ kind: "wechat", text: "x", currencies: ["CNY", "USD", "CNY"], showOnStatement: false })).toMatchObject({
      currencies: ["CNY", "USD"],
      showOnStatement: false,
    });
  });

  it("needs a contact value unless a QR payload is given", () => {
    expect(PaymentMethodInput.safeParse({ kind: "zelle", email: "  ", phone: "" }).success).toBe(false);
    expect(PaymentMethodInput.safeParse({ kind: "zelle" }).success).toBe(false);
    expect(PaymentMethodInput.parse({ kind: "zelle", qr: "https://example.com/pay/alex-demo" })).toMatchObject({
      email: null,
      phone: null,
      qr: "https://example.com/pay/alex-demo",
    });
    // A profile flag is enough: the email or phone comes from Settings > Profile.
    expect(PaymentMethodInput.parse({ kind: "zelle", useProfileEmail: true })).toMatchObject({ email: null, useProfileEmail: true, useProfilePhone: false });
    // An old client's single `handle` is not a field any more.
    expect(PaymentMethodInput.safeParse({ kind: "zelle", handle: "alex@example.com" }).success).toBe(false);
  });

  it("checks the email and phone formats", () => {
    const zelle = (v: object) => PaymentMethodInput.safeParse({ kind: "zelle", ...v }).success;
    expect(zelle({ email: "alex@example.com" })).toBe(true);
    expect(zelle({ email: "alex@example" })).toBe(false);
    expect(zelle({ email: "alex example.com" })).toBe(false);
    for (const phone of ["+1 555 010 0100", "(555) 010-0100", "5550100100", "+86 138 0013 8000", "555 0100"]) expect(zelle({ phone })).toBe(true);
    for (const phone of ["555 01", "call me", "+1 555.010.0100", "1".repeat(21), "+1 555 0100 ext 2"]) expect(zelle({ phone })).toBe(false);
  });

  it("keeps an original QR image beside the payload, clean by default, within 600 px and 300 KB", () => {
    const qr = "https://example.com/pay/alex-demo";
    const webp = (bytes: number) => `data:image/webp;base64,${"A".repeat(Math.ceil(bytes / 3) * 4)}`;
    const original = { dataUrl: webp(90_000), width: 600, height: 720 };
    expect(PaymentMethodInput.parse({ kind: "zelle", qr, original })).toMatchObject({ qr, original, display: "clean" });
    expect(PaymentMethodInput.parse({ kind: "zelle", qr, original, display: "original" }).display).toBe("original");
    expect(PaymentMethodInput.parse({ kind: "zelle", qr, original: { ...original, dataUrl: "data:image/png;base64,iVBORw0KGgo=" } }).original?.dataUrl).toMatch(
      /^data:image\/png/,
    );
    // Size: the decoded bytes, at most 300 KB.
    expect(dataUrlBytes("data:image/png;base64,AAAA")).toBe(3);
    expect(dataUrlBytes("data:image/png;base64,AAA=")).toBe(2);
    expect(PaymentMethodInput.safeParse({ kind: "zelle", qr, original: { ...original, dataUrl: webp(PAYMENT_ORIGINAL_MAX_BYTES) } }).success).toBe(true);
    expect(PaymentMethodInput.safeParse({ kind: "zelle", qr, original: { ...original, dataUrl: webp(PAYMENT_ORIGINAL_MAX_BYTES + 3) } }).success).toBe(false);
    // Only WebP or PNG data URLs, at most 600 px wide.
    for (const dataUrl of ["https://example.com/qr.png", "data:image/svg+xml;base64,PHN2Zz4=", "data:image/jpeg;base64,AAAA", "data:image/png;base64,AA A="]) {
      expect(PaymentMethodInput.safeParse({ kind: "zelle", qr, original: { ...original, dataUrl } }).success).toBe(false);
    }
    expect(PaymentMethodInput.safeParse({ kind: "zelle", qr, original: { ...original, width: 601 } }).success).toBe(false);
    // An original needs its payload, and "original" needs an image.
    expect(PaymentMethodInput.safeParse({ kind: "zelle", email: "alex@example.com", original }).success).toBe(false);
    expect(PaymentMethodInput.safeParse({ kind: "zelle", qr, display: "original" }).success).toBe(false);
    expect(PaymentMethodInput.safeParse({ kind: "zelle", qr, display: "photo" }).success).toBe(false);
  });

  it("enforces the limits", () => {
    const one = { kind: "venmo", username: "@alex-demo" } as const;
    expect(SetPaymentMethodsInput.safeParse({ methods: Array(6).fill(one) }).success).toBe(true);
    expect(SetPaymentMethodsInput.safeParse({ methods: Array(7).fill(one) }).success).toBe(false);
    expect(PaymentMethodInput.safeParse({ ...one, label: "x".repeat(41) }).success).toBe(false);
    expect(PaymentMethodInput.safeParse({ ...one, username: "x".repeat(201) }).success).toBe(false);
    expect(PaymentMethodInput.safeParse({ ...one, qr: "x".repeat(2049) }).success).toBe(false);
    expect(PaymentMethodInput.safeParse({ ...one, currencies: [] }).success).toBe(false);
    expect(PaymentMethodInput.safeParse({ ...one, currencies: ["usd"] }).success).toBe(false);
    expect(PaymentMethodInput.safeParse({ ...one, kind: "bitcoin" }).success).toBe(false);
  });

  it("statements show payment details by default and accept all seven flags", () => {
    expect(DEFAULT_STATEMENT_FLAGS).toContain("payment");
    const q = StatementQuery.parse({ participantId: "1", currency: "USD", show: "shared,names,myshare,notes,settlements,category,payment" });
    expect(q.show).toHaveLength(7);
  });
});
