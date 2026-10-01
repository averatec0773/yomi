import { AsyncLocalStorage } from "node:async_hooks";

export interface CurrentUser {
  id: number;
}

const requestUser = new AsyncLocalStorage<CurrentUser>();

/** Runs fn with `user` as the acting user for everything it calls (sync or async). The API wraps each request in it. */
export function runWithUser<T>(user: CurrentUser, fn: () => T): T {
  return requestUser.run(user, fn);
}

/** The LOCAL_MODE user (default on): user 1. Throws when LOCAL_MODE is off, since no auth is configured yet. */
export function localUser(): CurrentUser {
  const local = (process.env.LOCAL_MODE ?? "true").trim().toLowerCase();
  if (local === "true" || local === "1") return { id: 1 };
  throw new Error("LOCAL_MODE is off and no auth is configured yet");
}

/**
 * The only way code obtains the acting user: the request's user when one is in scope (runWithUser), otherwise the
 * LOCAL_MODE fallback, so background jobs, CLIs and server components keep working.
 */
export function getCurrentUser(): CurrentUser {
  return requestUser.getStore() ?? localUser();
}
