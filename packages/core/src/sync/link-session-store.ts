import { type Db, plaidLinkSessions } from "@yomi/db";
import { and, eq } from "@yomi/db/orm";
import { sha256Hex } from "../import/dedup";
import { sealSecret } from "../secrets/crypto";
import type { CurrentUser } from "../user";

export type LinkSessionRow = typeof plaidLinkSessions.$inferSelect;

/** One public token already traded for an access token: by the browser callback or by server-side recovery. */
export interface ExchangedEntry {
  h: string;
  via: "callback" | "recovery";
}

/** The entries of the jsonb `exchanged` list; anything malformed is dropped. */
export function parseExchanged(raw: unknown): ExchangedEntry[] {
  return Array.isArray(raw)
    ? raw.filter((e): e is ExchangedEntry => typeof e?.h === "string" && (e.via === "callback" || e.via === "recovery"))
    : [];
}

export const publicTokenHash = (publicToken: string) => sha256Hex(publicToken);

/** Persists a link token the moment it is created, before the browser ever sees it. Returns the row id. */
export async function recordLinkSession(
  db: Db,
  user: CurrentUser,
  input: { linkToken: string; environment: string; purpose: "new" | "update"; kind?: "bank" | "brokerage"; connectionId?: number | null },
): Promise<number> {
  return (await db
    .insert(plaidLinkSessions)
    .values({
      userId: user.id,
      linkToken: sealSecret(input.linkToken),
      environment: input.environment,
      purpose: input.purpose,
      kind: input.kind ?? "bank",
      connectionId: input.connectionId ?? null,
      status: "open",
    })
    .returning({ id: plaidLinkSessions.id })
    )[0]!.id;
}

export async function getLinkSession(db: Db, user: CurrentUser, id: number): Promise<LinkSessionRow | undefined> {
  return (await db
    .select()
    .from(plaidLinkSessions)
    .where(and(eq(plaidLinkSessions.userId, user.id), eq(plaidLinkSessions.id, id)))
    .limit(1))[0];
}

/**
 * Records that a public token of this session was exchanged (and for which connection), written
 * right after the access token is stored, so recovery never exchanges it a second time.
 */
export async function markExchanged(db: Db, user: CurrentUser, id: number, publicToken: string, via: ExchangedEntry["via"], connectionId: number | null): Promise<void> {
  await db.transaction(async (tx) => {
    const row = (await tx
      .select()
      .from(plaidLinkSessions)
      .where(and(eq(plaidLinkSessions.userId, user.id), eq(plaidLinkSessions.id, id)))
      .limit(1)
      .for("update"))[0];
    if (!row) return;
    const list = parseExchanged(row.exchanged);
    const h = publicTokenHash(publicToken);
    if (!list.some((e) => e.h === h)) list.push({ h, via });
    await tx.update(plaidLinkSessions)
      .set({ exchanged: list, connectionId: connectionId ?? row.connectionId })
      .where(eq(plaidLinkSessions.id, id));
  });
}
