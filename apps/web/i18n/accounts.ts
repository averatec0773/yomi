import type { Dictionary } from "./en";
import { fmt } from "./format";

/** `工商银行信用卡 3141`, `中国银行储蓄卡 5501`, `Bank of America 支票`: institution + account type + optional last four. */
const TYPED = /^(.+?)\s*(信用卡|储蓄卡|借记卡|支票)(?:\s*(\d{4}))?$/;

/**
 * Display name for a stored account name. Core creates account names in Chinese; English shows fixed
 * names (支付宝余额 → Alipay balance) and institution + type + last four in English, keeping an
 * institution without a translation as stored. zh-CN (and any name that matches nothing) shows the stored name.
 */
export function accountLabel(name: string, t: Dictionary): string {
  const a = t.accountNames;
  if (!a.translate) return name;
  const exact = a.exact[name];
  if (exact) return exact;
  const m = TYPED.exec(name.trim());
  if (!m) return name;
  const [, rawInstitution, rawType, last4] = m as unknown as [string, string, string, string | undefined];
  const institution = a.institutions[rawInstitution.trim()] ?? rawInstitution.trim();
  const type = a.types[rawType] ?? rawType;
  return last4 ? fmt(a.cardLast4, { institution, type, last4 }) : fmt(a.card, { institution, type });
}
