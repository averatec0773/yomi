import type { Db } from "@yomi/db";
import { getTimeZone } from "../settings/time-zone";
import { listParticipants } from "../split/participants";
import { todayIn } from "../time/zone";
import type { CurrentUser } from "../user";
import { parseQuickEntry, type QuickDraft } from "./parse";

/** Currency of an amount typed without one. */
const QUICK_DEFAULT_CURRENCY = "CNY";

/** Identity kinds nobody types into a quick entry, so they are not names to match (a Zelle e-mail or phone). */
const NOT_ALIASES = new Set(["zelle_email", "zelle_phone"]);

/**
 * Parses quick-entry text against the user's participants (their identities as aliases) and today in the user's zone
 * (`today` pins it); an amount without a currency is CNY unless `defaultCurrency` says otherwise. Nothing is written.
 */
export async function quickDraft(db: Db, user: CurrentUser, input: { text: string; today?: string; defaultCurrency?: string }): Promise<QuickDraft> {
  const timeZone = await getTimeZone(db, user);
  return parseQuickEntry(input.text, {
    today: input.today ?? todayIn(timeZone),
    timeZone,
    participants: (await listParticipants(db, user)).map((p) => ({
      id: p.id,
      name: p.name,
      isSelf: p.isSelf,
      aliases: p.identities.filter((i) => !NOT_ALIASES.has(i.kind)).map((i) => i.value),
    })),
    defaultCurrency: input.defaultCurrency ?? QUICK_DEFAULT_CURRENCY,
  });
}
