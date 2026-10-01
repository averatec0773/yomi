"use client";

import {
  ArrowLeftRightIcon,
  ChevronRightIcon,
  DatabaseBackupIcon,
  DatabaseIcon,
  FileDownIcon,
  FileInputIcon,
  GlobeIcon,
  HammerIcon,
  HandCoinsIcon,
  KeyboardIcon,
  LandmarkIcon,
  ListChecksIcon,
  SlidersHorizontalIcon,
  TagsIcon,
  UsersIcon,
  type LucideIcon,
} from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import type { Person } from "@/components/split/candidates";
import { TransferDialog } from "@/components/split/transfer-sheet";
import { openShortcuts } from "@/components/shell/nav";
import { IconTile } from "@/components/ui-kit/icon-tile";
import { ListCard } from "@/components/ui-kit/list-card";
import { useT } from "@/i18n/client";

const row =
  "group flex h-14 w-full items-center gap-3 px-4 text-left outline-none transition-colors duration-[120ms] hover:bg-tile/50 focus-visible:bg-tile/50 focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:ring-inset md:px-5";

function RowBody({ icon, title, hint }: { icon: LucideIcon; title: string; hint: string }) {
  return (
    <>
      <IconTile icon={icon} className="transition-colors duration-[120ms] group-hover:text-foreground" />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-body font-medium">{title}</span>
        <span className="block truncate text-meta text-2">{hint}</span>
      </span>
      <ChevronRightIcon aria-hidden className="size-4 shrink-0 text-3 transition-colors duration-[120ms] group-hover:text-foreground" />
    </>
  );
}

function Row({ href, icon, title, hint }: { href: string; icon: LucideIcon; title: string; hint: string }) {
  return (
    <Link href={href} className={row}>
      <RowBody icon={icon} title={title} hint={hint} />
    </Link>
  );
}

/**
 * The Tools hub: sectioned compact lists (56px rows: icon tile, title, one-line hint, chevron), two columns from 1200px.
 * Record a transfer or repayment opens its dialog in place. Maintenance rows deep-link to /settings sections, which
 * flash when reached. Settings and Keyboard shortcuts show on phones only (no sidebar there).
 *
 * Future tools go into these sections, not as placeholder rows: a weekly report under Split (or a new Reports section),
 * subscriptions under Data, SMS / email capture under Data.
 */
export function ToolsHub({ people, currencies, today }: { people: Person[]; currencies: string[]; today: string }) {
  const t = useT().tools;
  const [transfer, setTransfer] = useState(false);
  return (
    <>
      <div className="grid items-start gap-6 min-[1200px]:grid-cols-2">
        <div className="flex min-w-0 flex-col gap-6">
          <ListCard title={t.sections.split} icon={HandCoinsIcon}>
            <Row href="/split" icon={UsersIcon} title={t.split} hint={t.splitHint} />
            {people.length > 0 ? (
              <button type="button" className={row} onClick={() => setTransfer(true)}>
                <RowBody icon={ArrowLeftRightIcon} title={t.transfer} hint={t.transferHint} />
              </button>
            ) : (
              <Row href="/split" icon={ArrowLeftRightIcon} title={t.transfer} hint={t.transferEmptyHint} />
            )}
          </ListCard>
          <ListCard title={t.sections.data} icon={DatabaseIcon}>
            <Row href="/import" icon={FileInputIcon} title={t.import} hint={t.importHint} />
            <Row href="/settings?tab=connections" icon={LandmarkIcon} title={t.banks} hint={t.banksHint} />
            <Row href="/tools/rules" icon={ListChecksIcon} title={t.rules} hint={t.rulesHint} />
          </ListCard>
        </div>
        <div className="flex min-w-0 flex-col gap-6">
          <ListCard title={t.sections.maintenance} icon={HammerIcon}>
            <Row href="/settings?tab=data#backup" icon={DatabaseBackupIcon} title={t.backup} hint={t.backupHint} />
            <Row href="/settings?tab=data#export" icon={FileDownIcon} title={t.export} hint={t.exportHint} />
            <Row href="/settings?tab=data#recategorize" icon={TagsIcon} title={t.recategorize} hint={t.recategorizeHint} />
            <Row href="/settings?tab=general#time-zone" icon={GlobeIcon} title={t.timeZone} hint={t.timeZoneHint} />
          </ListCard>
          {/* Phones have no sidebar: Settings and Shortcuts live here. */}
          <ListCard className="md:hidden">
            <Row href="/settings" icon={SlidersHorizontalIcon} title={t.settings} hint={t.settingsHint} />
            <button type="button" className={row} onClick={openShortcuts}>
              <RowBody icon={KeyboardIcon} title={t.shortcuts} hint={t.shortcutsHint} />
            </button>
          </ListCard>
        </div>
      </div>
      <TransferDialog open={transfer} onOpenChange={setTransfer} people={people} currencies={currencies} today={today} />
    </>
  );
}
