import { DatabaseIcon, KeyboardIcon, PaletteIcon, PlugIcon, Settings2Icon, ShieldCheckIcon, UserRoundIcon, type LucideIcon } from "lucide-react";
import {
  balances,
  getCurrentUser,
  getDisplayName,
  getPaymentMethods,
  getProfileContact,
  listParticipants,
  readAccessToken,
  settingsStatus,
} from "@yomi/core";
import { dbTarget, pgDumpHint } from "@yomi/db";
import { connection } from "next/server";
import type { ReactNode } from "react";
import { SignOutButton } from "@/components/access/access-form";
import { AppearanceSettings } from "@/components/appearance-settings";
import { ConnectionsPanel } from "@/components/bank/connections-panel";
import { CsvLink } from "@/components/csv-link";
import { BackupButton } from "@/components/import/backup-button";
import { Recategorize } from "@/components/import/recategorize";
import { LanguageToggle } from "@/components/shell/language-toggle";
import { PaymentSettings } from "@/components/payment-settings";
import { ProfileContactProvider, ProfileSettings } from "@/components/profile-settings";
import { SettingsPanel, SettingsTabs, type SettingsTab } from "@/components/settings-tabs";
import { ShortcutSettings } from "@/components/shortcut-settings";
import { AnchorFlash } from "@/components/ui-kit/anchor-flash";
import { ListCard } from "@/components/ui-kit/list-card";
import { PageHeader } from "@/components/ui-kit/page-header";
import { TimeZonePicker } from "@/components/time-zone-picker";
import { TransferNames } from "@/components/transfer-names";
import { fmt } from "@/i18n";
import { errorText } from "@/i18n/errors";
import { getI18n } from "@/i18n/server";
import { getDb } from "@/lib/db";
import { getToday } from "@/lib/settings";
import { cn } from "@/lib/utils";

export async function generateMetadata() {
  const { t } = await getI18n();
  return { title: t.settings.metaTitle };
}

/** Each module's icon: 16px in its tab, 18px before its section title. */
const ICONS: Record<SettingsTab, LucideIcon> = {
  general: Settings2Icon,
  profile: UserRoundIcon,
  appearance: PaletteIcon,
  shortcuts: KeyboardIcon,
  connections: PlugIcon,
  security: ShieldCheckIcon,
  data: DatabaseIcon,
};
const TAB_ICONS = Object.fromEntries(
  Object.entries(ICONS).map(([id, Icon]) => [id, <Icon key={id} aria-hidden />]),
) as Record<SettingsTab, ReactNode>;

/** One module: a tab panel (`SettingsPanel`, shown while `?tab=` names it) that opens with the section title. */
function Section({ id, title, children }: { id: SettingsTab; title: string; children: ReactNode }) {
  const Icon = ICONS[id];
  return (
    <SettingsPanel id={id} className="flex max-w-narrow scroll-mt-18 flex-col gap-3">
      <h2 className="flex items-center gap-2 text-title font-semibold">
        <Icon className="size-[18px] text-2" aria-hidden />
        {title}
      </h2>
      {children}
    </SettingsPanel>
  );
}

/** A deep-link target inside a panel (/settings?tab=data#backup from Tools): scrolls under the tab bar and flashes on arrival. */
function Anchor({ id, gap, children }: { id: string; gap: "gap-2" | "gap-3"; children: ReactNode }) {
  return (
    <div id={id} data-anchor className={cn("flex scroll-mt-18 flex-col", gap)}>
      {children}
    </div>
  );
}

/** One status line: a label, a calm set / not set marker and details under it. */
function StatusRow({ label, ok, state, children }: { label: string; ok: boolean; state: string; children?: ReactNode }) {
  return (
    <li className="flex flex-col gap-0.5 px-4 py-3 md:px-5">
      <div className="flex items-center justify-between gap-3 text-body">
        <span>{label}</span>
        <span className={cn("shrink-0 text-meta", ok ? "text-foreground" : "text-2")}>
          <span aria-hidden className={cn("mr-1.5 inline-block size-1.5 rounded-full align-middle", ok ? "bg-foreground/70" : "bg-foreground/25")} />
          {state}
        </span>
      </div>
      {children && <div className="text-meta text-2">{children}</div>}
    </li>
  );
}

export default async function SettingsPage() {
  await connection();
  const { t } = await getI18n();
  const s = t.settings;
  const db = await getDb();
  const user = getCurrentUser();
  const status = await settingsStatus(db, user);
  const lines = await balances(db, user);
  const me = (await listParticipants(db, user)).find((p) => p.isSelf)!;
  const month = (await getToday()).slice(0, 7);
  const { security } = status;
  const accessOn = readAccessToken() !== null;
  // A Postgres server is backed up with pg_dump (yomi only copies its own PGlite directory).
  const serverDb = dbTarget(db).kind === "server";

  return (
    <div className="flex flex-col gap-6">
      <PageHeader title={s.title} className="mb-0" />
      <SettingsTabs icons={TAB_ICONS} />

      <Section id="general" title={s.general}>
        <Anchor id="language" gap="gap-2">
          <h3 className="text-body font-medium">{s.language}</h3>
          <p className="text-body text-2">{s.languageHint}</p>
          <LanguageToggle className="self-start" />
        </Anchor>
        <Anchor id="time-zone" gap="gap-2">
          <h3 className="text-body font-medium">{s.timeZone}</h3>
          <p className="text-body text-2">{s.timeZoneHint}</p>
          <TimeZonePicker />
        </Anchor>
      </Section>

      <Section id="profile" title={s.profile.title}>
        <ProfileContactProvider initial={await getProfileContact(db, user)}>
          <ProfileSettings initialName={await getDisplayName(db, user)} />
          <TransferNames selfId={me.id} initial={me.identities} />
          <div id="payment-methods" data-anchor className="mt-4 scroll-mt-18">
            <PaymentSettings initial={await getPaymentMethods(db, user)} />
          </div>
        </ProfileContactProvider>
      </Section>

      <Section id="appearance" title={s.appearance.title}>
        <p className="text-body text-2">{s.appearance.hint}</p>
        <AppearanceSettings />
      </Section>

      <Section id="shortcuts" title={s.keys.title}>
        <p className="text-body text-2">{s.keys.hint}</p>
        <ShortcutSettings />
      </Section>

      <Section id="connections" title={s.connections}>
        <ConnectionsPanel ibkr={status.ibkr} />
      </Section>

      <Section id="security" title={s.security}>
        <ListCard>
        <ul className="divide-y divide-line-soft" data-testid="settings-security">
          <StatusRow
            label={s.secretKey}
            ok={security.key === "present" && security.errorCode === null}
            state={security.key === "present" ? s.configured : s.notConfigured}
          >
            <p className="break-words">
              {security.key === "malformed"
                ? s.keyMalformed
                : security.keySource === "env"
                  ? s.keyPresent
                  : security.keySource === "file"
                    ? fmt(s.keyFilePresent, { file: security.keyFile ?? "" })
                    : fmt(s.keyMissing, { file: security.keyFile ?? "" })}
            </p>
            <p>
              {security.encryptedTokens + security.plaintextTokens === 0
                ? s.noTokens
                : fmt(s.tokens, { encrypted: security.encryptedTokens, plaintext: security.plaintextTokens })}
            </p>
            {security.errorCode && <p className="text-foreground">{errorText({ code: security.errorCode, message: security.errorCode }, t)}</p>}
          </StatusRow>
          <StatusRow label={s.accessToken} ok={accessOn} state={accessOn ? s.accessOn : s.accessOff}>
            <div className="flex flex-col gap-2">
              <p>{accessOn ? s.accessOnHint : s.accessOffHint}</p>
              {accessOn && <SignOutButton />}
            </div>
          </StatusRow>
        </ul>
        </ListCard>
        <p className="text-meta text-2">{s.secretsNote}</p>
      </Section>

      <Section id="data" title={s.data}>
        <Anchor id="backup" gap="gap-3">
          <h3 className="text-body font-medium">{s.backup}</h3>
          {serverDb ? (
            <>
              <p className="text-body text-2">{s.backupServerBody}</p>
              <p className="text-meta break-all font-mono text-foreground" data-testid="pg-dump-hint">{pgDumpHint()}</p>
            </>
          ) : (
            <>
              <p className="text-body text-2">{s.backupBody}</p>
              <BackupButton />
            </>
          )}
        </Anchor>

        <Anchor id="export" gap="gap-2">
          <h3 className="text-body font-medium">{s.export}</h3>
          <p className="text-body text-2">{s.exportBody}</p>
          <ListCard>
          <ul className="divide-y divide-line-soft">
            <li className="flex min-h-12 items-center justify-between gap-3 px-4 text-body md:px-5">
              <span>{s.allTransactions}</span>
              <CsvLink href="/api/export/transactions.csv" />
            </li>
            <li className="flex min-h-12 items-center justify-between gap-3 px-4 text-body md:px-5">
              <span>{s.monthTransactions}</span>
              <CsvLink href={`/api/export/transactions.csv?month=${month}`} />
            </li>
            {lines.map((b) => (
              <li
                key={`${b.participantId}|${b.currency}`}
                className="flex min-h-12 items-center justify-between gap-3 px-4 text-body md:px-5"
              >
                <span>
                  {fmt(s.splitWith, { name: b.name })} <span className="text-meta text-2">{b.currency}</span>
                </span>
                <CsvLink href={`/api/export/split.csv?participantId=${b.participantId}&currency=${b.currency}`} />
              </li>
            ))}
          </ul>
          </ListCard>
        </Anchor>

        <Anchor id="recategorize" gap="gap-3">
          <h3 className="text-body font-medium">{s.recategorize}</h3>
          <p className="text-body text-2">{s.recategorizeBody}</p>
          <Recategorize />
        </Anchor>
      </Section>
      <AnchorFlash />
    </div>
  );
}
