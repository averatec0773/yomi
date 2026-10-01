"use client";

import type { TimeZoneChange } from "@yomi/contracts";
import { DEFAULT_TIME_ZONE, occurredTimeFor } from "@yomi/core/time";
import { useRouter } from "next/navigation";
import { createContext, type ReactNode, use, useEffect } from "react";
import { apiFetch } from "./api";

const TimeZoneContext = createContext<string>(DEFAULT_TIME_ZONE);

/** Sources whose times are Beijing time (+08:00): a row's day there can differ from the user's day. */
const BEIJING_SOURCES: ReadonlySet<string> = new Set(["alipay", "wechat", "icbc_pdf", "sms"]);

/**
 * Mounted once in the root layout with the stored zone. On the first visit (no zone stored) it posts the
 * browser's zone once and refreshes, so server-rendered days regroup.
 */
export function TimeZoneProvider({ timeZone, isSet, children }: { timeZone: string; isSet: boolean; children: ReactNode }) {
  const router = useRouter();
  useEffect(() => {
    if (isSet) return;
    const detected = Intl.DateTimeFormat().resolvedOptions().timeZone;
    if (!detected) return;
    apiFetch<TimeZoneChange>("/settings/time-zone", { method: "PUT", json: { timeZone: detected, ifUnset: true }, silent: true })
      .then((r) => {
        if (r.timeZone !== timeZone || r.changed > 0) router.refresh();
      })
      .catch(() => {});
  }, [isSet, timeZone, router]);
  return <TimeZoneContext value={timeZone}>{children}</TimeZoneContext>;
}

/** The user's IANA time zone in client components. */
export function useTimeZone(): string {
  return use(TimeZoneContext);
}

/** 'HH:MM' of a transaction in the user's zone. */
export function localTimeOf(tx: { occurredAt: string; source: string }, timeZone: string): string {
  return occurredTimeFor(tx.occurredAt, tx.source, timeZone).slice(0, 5);
}

/** The Beijing date of a row from a Chinese source when it differs from its local day, else null. */
export function beijingDateIfDifferent(tx: { occurredAt: string; occurredOn: string; source: string }): string | null {
  if (!BEIJING_SOURCES.has(tx.source) || !tx.occurredAt.endsWith("+08:00")) return null;
  const booked = tx.occurredAt.slice(0, 10);
  return booked !== tx.occurredOn ? booked : null;
}
