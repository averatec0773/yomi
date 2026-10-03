import {
  type ApiError,
  type BackupResult,
  mergeShortcuts,
  type PaymentMethodsSetting,
  type ProfileSetting,
  SetPaymentMethodsInput,
  SetProfileInput,
  SetShortcutsInput,
  SetThemeInput,
  SetTimeZoneInput,
  SHORTCUT_DEFAULTS,
  type ShortcutAction,
  type ShortcutBindings,
  type SettingsStatus,
  shortcutOverrides,
  shortcutProblems,
  type ShortcutsSetting,
  StatementQuery,
  type ThemeSetting,
  type TimeZoneChange,
  type TimeZoneSetting,
  TransactionsCsvQuery,
} from "@yomi/contracts";
import {
  exportSplitCsv,
  exportTransactionsCsv,
  getCurrentUser,
  getDisplayName,
  getPaymentMethods,
  getProfileContact,
  getShortcutOverrides,
  getTheme,
  getTimeZoneSetting,
  isTimeZone,
  setDisplayName,
  setPaymentMethods,
  setProfileContact,
  setShortcutOverrides,
  settingsStatus,
  setTheme,
  setTimeZone,
} from "@yomi/core";
import { backupDatabase, type Db, dbTarget, pgDumpHint } from "@yomi/db";
import { Hono } from "hono";
import { readJson, readQuery } from "./http";

function csv(body: string, fileName: string): Response {
  return new Response(body, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${fileName.replace(/[^\x20-\x7e]/g, "_")}"; filename*=UTF-8''${encodeURIComponent(fileName)}`,
      "Cache-Control": "no-store",
    },
  });
}

/** Routes: /maintenance/backup, /settings/status, /settings/time-zone, /settings/shortcuts, /settings/profile, /settings/payment-methods, /settings/theme, /export/transactions.csv, /export/split.csv (mounted under /api). */
export function maintenanceRoutes(deps: { getDb: () => Db | Promise<Db> }): Hono {
  const r = new Hono();

  r.post("/maintenance/backup", async (c) => {
    const db = await deps.getDb();
    if (dbTarget(db).kind === "server") {
      const command = pgDumpHint();
      return c.json({ error: `yomi does not back up a Postgres server itself. Run: ${command}`, code: "backup_server", params: { command } } satisfies ApiError, 409);
    }
    const file = await backupDatabase(db, "manual");
    if (!file) return c.json({ error: "An in-memory database has no file to back up", code: "backup_in_memory" } satisfies ApiError, 409);
    return c.json({ path: file, fileName: file.split(/[/\\]/).pop() ?? file } satisfies BackupResult);
  });

  r.get("/settings/status", async (c) => c.json((await settingsStatus(await deps.getDb(), getCurrentUser())) satisfies SettingsStatus));

  r.get("/settings/time-zone", async (c) => c.json((await getTimeZoneSetting(await deps.getDb(), getCurrentUser())) satisfies TimeZoneSetting));

  /** Stores the zone and regroups every transaction by it; with ifUnset, a no-op once a zone is stored. */
  r.put("/settings/time-zone", async (c) => {
    const body = await readJson(c, SetTimeZoneInput);
    if (!isTimeZone(body.timeZone)) {
      return c.json({ error: `Unknown time zone: ${body.timeZone}`, code: "invalid_time_zone", params: { value: body.timeZone } } satisfies ApiError, 400);
    }
    const db = await deps.getDb();
    const user = getCurrentUser();
    const current = await getTimeZoneSetting(db, user);
    if (body.ifUnset && current.isSet) return c.json({ ...current, changed: 0 } satisfies TimeZoneChange);
    return c.json((await setTimeZone(db, user, body.timeZone)) satisfies TimeZoneChange);
  });

  r.get("/settings/shortcuts", async (c) =>
    c.json({ overrides: shortcutOverrides(mergeShortcuts(await getShortcutOverrides(await deps.getDb(), getCurrentUser()))) } satisfies ShortcutsSetting),
  );

  /** Replaces the keyboard shortcut overrides (`{}` resets); refuses two actions on one key in the same scope. */
  r.put("/settings/shortcuts", async (c) => {
    const body = await readJson(c, SetShortcutsInput);
    const bindings: ShortcutBindings = { ...SHORTCUT_DEFAULTS, ...body.overrides };
    const problems = Object.entries(shortcutProblems(bindings));
    if (problems.length > 0) {
      const [action, problem] = problems[0]!;
      return c.json(
        {
          error: `Shortcut ${action}: ${problem.code}`,
          code: "invalid_shortcuts",
          params: { action, key: bindings[action as ShortcutAction], problem: problem.code },
        } satisfies ApiError,
        400,
      );
    }
    return c.json({ overrides: shortcutOverrides(mergeShortcuts(await setShortcutOverrides(await deps.getDb(), getCurrentUser(), shortcutOverrides(bindings)))) } satisfies ShortcutsSetting);
  });

  const profile = async (): Promise<ProfileSetting> => {
    const db = await deps.getDb();
    const user = getCurrentUser();
    return { displayName: await getDisplayName(db, user), ...(await getProfileContact(db, user)) };
  };

  r.get("/settings/profile", async (c) => c.json((await profile()) satisfies ProfileSetting));

  /**
   * Sets the fields sent: the display name shown on statements, and the email and phone payment methods show. An
   * empty value clears that field.
   */
  r.put("/settings/profile", async (c) => {
    const body = await readJson(c, SetProfileInput);
    const db = await deps.getDb();
    const user = getCurrentUser();
    if (body.displayName !== undefined) await setDisplayName(db, user, body.displayName);
    const contact = {
      ...(body.email !== undefined && { email: body.email }),
      ...(body.phone !== undefined && { phone: body.phone }),
    };
    if (Object.keys(contact).length > 0) await setProfileContact(db, user, contact);
    return c.json((await profile()) satisfies ProfileSetting);
  });

  r.get("/settings/payment-methods", async (c) =>
    c.json({ methods: await getPaymentMethods(await deps.getDb(), getCurrentUser()) } satisfies PaymentMethodsSetting),
  );

  /** Replaces the payment methods shown on statements ("How to pay"), in display order; `[]` removes them. */
  r.put("/settings/payment-methods", async (c) => {
    const body = await readJson(c, SetPaymentMethodsInput);
    return c.json({ methods: await setPaymentMethods(await deps.getDb(), getCurrentUser(), body.methods) } satisfies PaymentMethodsSetting);
  });

  r.get("/settings/theme", async (c) => c.json({ theme: await getTheme(await deps.getDb(), getCurrentUser()) } satisfies ThemeSetting));

  /** Stores the color theme; `system` removes the stored value. */
  r.put("/settings/theme", async (c) => {
    const body = await readJson(c, SetThemeInput);
    return c.json({ theme: await setTheme(await deps.getDb(), getCurrentUser(), body.theme) } satisfies ThemeSetting);
  });

  r.get("/export/transactions.csv", async (c) => {
    const { month, from, to, locale } = readQuery(c, TransactionsCsvQuery);
    const label = from !== undefined || to !== undefined ? `${from ?? ""}_${to ?? ""}` : (month ?? "all");
    return csv(await exportTransactionsCsv(await deps.getDb(), getCurrentUser(), { month, from, to, locale }), `yomi-transactions-${label}.csv`);
  });

  r.get("/export/split.csv", async (c) => {
    const q = readQuery(c, StatementQuery);
    const body = await exportSplitCsv(await deps.getDb(), getCurrentUser(), q.participantId, q.currency, { since: q.since, locale: q.locale, scope: q.scope, itemIds: q.items, show: q.show });
    return csv(body, `yomi-split-${q.participantId}-${q.currency}.csv`);
  });

  return r;
}
