import { expect, type Frame, type Page } from "@playwright/test";
import pg from "pg";

/**
 * Shared by the opt-in Plaid Sandbox specs (PLAID_SANDBOX_E2E=1). PLAID_E2E_DB is the server's throwaway
 * DATABASE_URL, a postgres:// URL: a PGlite directory can only be open in the server process itself.
 */
export const dbPath = process.env.PLAID_E2E_DB;

/** Query against the server's database (never your own ledger: the URL comes from PLAID_E2E_DB). Params are $1, $2, ... */
export async function query<T>(sql: string, ...params: (string | number)[]): Promise<T[]> {
  const client = new pg.Client({ connectionString: dbPath! });
  await client.connect();
  try {
    return (await client.query(sql, params)).rows as T[];
  } finally {
    await client.end();
  }
}

export const connections = () =>
  query<{ id: number; enrollment_id: string; institution_name: string; status: string; kind: string }>(
    "select id, enrollment_id, institution_name, status, kind from bank_connections order by id",
  );

export const session = (id: number) =>
  query<{ status: string; connection_id: number | null; link_session_id: string | null; kind: string }>(
    "select status, connection_id, link_session_id, kind from plaid_link_sessions where id = $1",
    id,
  ).then((r) => r[0]);

/** First characters of an id, for logs. */
export const mask = (v: string | null | undefined) => (v ? `${v.slice(0, 12)}…` : v);

/** The Plaid Link iframe, once it is there. */
export async function plaidFrame(page: Page): Promise<Frame> {
  await expect.poll(() => page.frames().some((f) => f.url().includes("cdn.plaid.com/link/v2/stable/link.html")), { timeout: 30_000 }).toBe(true);
  return page.frames().find((f) => f.url().includes("cdn.plaid.com/link/v2/stable/link.html"))!;
}
