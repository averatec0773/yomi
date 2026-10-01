"use client";

import type { Identity, IdentityInput, IdentityKind, MerchantRule, Participant } from "@yomi/contracts";
import { CheckIcon, ChevronDownIcon, ContactIcon, PlusIcon, UserPlusIcon, XIcon } from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui-kit/button";
import { fmt } from "@/i18n";
import { useT } from "@/i18n/client";
import { apiFetch } from "@/lib/api";
import { cn } from "@/lib/utils";
import { KIND_ORDER, KindIcon } from "./identity-kinds";
import { NativeSelect, TextInput, useMutation } from "./ui";

function IdentityForm({
  onAdd,
  busy,
  compact,
}: {
  onAdd: (input: IdentityInput) => Promise<boolean>;
  busy: boolean;
  compact?: boolean;
}) {
  const t = useT();
  const pt = t.split.participants;
  const [kind, setKind] = useState<IdentityKind>("wechat");
  const [value, setValue] = useState("");
  return (
    <div>
      <div className={cn("flex items-center gap-2", compact && "flex-wrap")}>
        <NativeSelect
          value={kind}
          onChange={(e) => setKind(e.target.value as IdentityKind)}
          className="h-7 w-auto text-meta"
          aria-label={pt.identityKind}
        >
          {KIND_ORDER.map((k) => (
            <option key={k} value={k}>
              {t.split.kinds[k]}
            </option>
          ))}
        </NativeSelect>
        <TextInput
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder={t.split.kindPlaceholders[kind]}
          aria-label={pt.identity}
          className="h-7 min-w-0 flex-1 text-meta"
          onKeyDown={async (e) => {
            if (e.key !== "Enter") return;
            e.preventDefault();
            if (value.trim() && (await onAdd({ kind, value: value.trim() }))) setValue("");
          }}
        />
        <Button
          size="sm"
          disabled={busy || !value.trim()}
          onClick={async () => {
            if (await onAdd({ kind, value: value.trim() })) setValue("");
          }}
        >
          <PlusIcon aria-hidden />
          {pt.addIdentity}
        </Button>
      </div>
      {kind.startsWith("zelle_") && <p className="mt-1 text-meta text-2">{t.split.zelleNote}</p>}
    </div>
  );
}

export function AddParticipant({ autoFocus, compact }: { autoFocus?: boolean; compact?: boolean }) {
  const { run, busy } = useMutation();
  const t = useT();
  const pt = t.split.participants;
  const [name, setName] = useState("");
  const [kind, setKind] = useState<IdentityKind>("wechat");
  const [value, setValue] = useState("");
  return (
    <form
      className="grid gap-1"
      onSubmit={async (e) => {
        e.preventDefault();
        if (!name.trim()) return;
        const identities = value.trim() ? [{ kind, value: value.trim() }] : [];
        const p = await run(() => apiFetch<Participant>("/participants", { json: { name: name.trim(), identities } }));
        if (p) {
          toast.success(fmt(pt.added, { name: p.name }));
          setName("");
          setValue("");
        }
      }}
    >
      <div className={cn("grid gap-2 sm:grid-cols-[13rem_auto_1fr_auto]", compact && "sm:grid-cols-[8rem_auto_1fr_auto]")}>
        <TextInput value={name} onChange={(e) => setName(e.target.value)} placeholder={pt.namePlaceholder} aria-label={pt.name} autoFocus={autoFocus} />
        <NativeSelect value={kind} onChange={(e) => setKind(e.target.value as IdentityKind)} className="w-auto" aria-label={pt.identityKind}>
          {KIND_ORDER.map((k) => (
            <option key={k} value={k}>
              {t.split.kinds[k]}
            </option>
          ))}
        </NativeSelect>
        <TextInput
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder={`${t.split.kindPlaceholders[kind]}${pt.optionalSuffix}`}
          aria-label={pt.identity}
        />
        <Button variant={compact ? "soft" : "primary"} phoneSoft type="submit" disabled={busy || !name.trim()}>
          <UserPlusIcon aria-hidden />
          {t.common.add}
        </Button>
      </div>
      {kind.startsWith("zelle_") && <p className="text-meta text-2">{t.split.zelleNote}</p>}
    </form>
  );
}

function IdentityGroups({ p, onRemove, busy }: { p: Participant; onRemove: (i: Identity) => void; busy: boolean }) {
  const t = useT();
  const pt = t.split.participants;
  const groups = KIND_ORDER.map((k) => ({ kind: k, items: p.identities.filter((i) => i.kind === k) })).filter((g) => g.items.length > 0);
  if (groups.length === 0) return <p className="text-meta text-3">{pt.noIdentities}</p>;
  return (
    <ul className="grid gap-1" aria-label={fmt(pt.identitiesAria, { name: p.name })}>
      {groups.map((g) => (
        <li key={g.kind} className="flex flex-wrap items-center gap-1.5">
          <KindIcon kind={g.kind} />
          <span className="w-16 shrink-0 text-meta text-2">{t.split.kinds[g.kind]}</span>
          {g.items.map((i) => (
            <span key={i.id} className="inline-flex h-6 items-center gap-1 rounded-full bg-sunken pr-1 pl-2.5 text-meta">
              {i.value}
              {i.source === "claimed" && <span className="text-3">{pt.claimedMark}</span>}
              <button
                type="button"
                disabled={busy}
                onClick={() => onRemove(i)}
                aria-label={fmt(pt.removeAria, { value: i.value })}
                className="hit relative inline-flex size-4 items-center justify-center rounded-full text-2 hover:bg-border hover:text-foreground"
              >
                <XIcon className="size-3" aria-hidden />
              </button>
            </span>
          ))}
        </li>
      ))}
    </ul>
  );
}

function ParticipantRow({ p }: { p: Participant }) {
  const { run, busy } = useMutation();
  const t = useT();
  const pt = t.split.participants;
  const [name, setName] = useState(p.name);
  const dirty = name.trim() !== p.name;
  const archived = p.archivedAt !== null;

  async function save() {
    if (!name.trim()) return;
    const out = await run(() => apiFetch<Participant>(`/participants/${p.id}`, { method: "PATCH", json: { name: name.trim() } }));
    if (out) toast.success(fmt(pt.saved, { name: out.name }));
  }

  return (
    <li className={cn("grid gap-2 border-b border-border py-3", archived && "opacity-60")}>
      <div className="grid gap-2 sm:grid-cols-[8rem_1fr_auto] sm:items-start">
        <TextInput
          value={p.isSelf ? t.common.me : name}
          disabled={p.isSelf || busy}
          onChange={(e) => setName(e.target.value)}
          aria-label={pt.name}
          onKeyDown={(e) => e.key === "Enter" && dirty && void save()}
        />
        <div className="min-w-0 sm:pt-1">
          {p.isSelf ? (
            <p className="text-meta text-3">{pt.yourself}</p>
          ) : (
            <IdentityGroups
              p={p}
              busy={busy}
              onRemove={async (i) => {
                const out = await run(() => apiFetch(`/identities/${i.id}`, { method: "DELETE" }));
                if (out) toast(fmt(pt.removedIdentity, { name: p.name, kind: t.split.kinds[i.kind], value: i.value }));
              }}
            />
          )}
        </div>
        <div className="flex items-center justify-end gap-1">
          {dirty && (
            <Button variant="soft" size="sm" disabled={busy || !name.trim()} onClick={() => void save()}>
              <CheckIcon aria-hidden />
              {t.common.save}
            </Button>
          )}
          <Button
            variant="ghost"
            size="sm"
            disabled={p.isSelf || busy}
            title={p.isSelf ? pt.selfNoArchive : undefined}
            onClick={async () => {
              const out = await run(() =>
                apiFetch<Participant>(`/participants/${p.id}`, { method: "PATCH", json: { archived: !archived } }),
              );
              if (out) toast(fmt(archived ? pt.restored : pt.archivedToast, { name: out.name }));
            }}
          >
            {archived ? pt.restore : pt.archive}
          </Button>
        </div>
      </div>
      {!p.isSelf && !archived && (
        <div className="sm:pl-[calc(8rem+0.5rem)]">
          <IdentityForm
            busy={busy}
            compact
            onAdd={async (input) => {
              const out = await run(() => apiFetch<Identity>(`/participants/${p.id}/identities`, { json: input }));
              if (out) toast.success(fmt(pt.identityAdded, { name: p.name, kind: t.split.kinds[out.kind], value: out.value }));
              return out !== undefined;
            }}
          />
        </div>
      )}
    </li>
  );
}

/** Collapsed "People" section: add, rename, identities by kind, archive, and the auto-split rules. */
export function ParticipantsPanel({ participants, autoRules }: { participants: Participant[]; autoRules: MerchantRule[] }) {
  const t = useT();
  const pt = t.split.participants;
  const sorted = [...participants].sort((a, b) => Number(a.archivedAt !== null) - Number(b.archivedAt !== null));
  return (
    <details className="group rounded-2xl border border-border bg-surface px-5 md:px-6 [&[open]]:pb-5">
      <summary className="flex cursor-pointer list-none items-center gap-2.5 py-4 text-title font-semibold select-none [&::-webkit-details-marker]:hidden">
        <ContactIcon className="size-[18px] shrink-0 text-2" aria-hidden />
        <span className="flex-1">
          {pt.title}
          <span className="ml-1.5 text-body font-normal text-3">{participants.filter((p) => !p.isSelf).length}</span>
          {autoRules.length > 0 && <span className="ml-3 text-meta font-normal text-2">{fmt(pt.autoCount, { count: autoRules.length })}</span>}
        </span>
        <ChevronDownIcon aria-hidden className="size-4 text-3 transition-transform duration-[120ms] group-open:rotate-180" />
      </summary>
      <p className="text-meta text-2">
        {pt.intro}
      </p>
      <ul className="mt-2 border-t border-border">
        {sorted.map((p) => (
          <ParticipantRow key={`${p.id}|${p.name}|${p.archivedAt}`} p={p} />
        ))}
      </ul>
      <div className="mt-4">
        <AddParticipant compact />
      </div>
      <p className="mt-6 text-meta text-2">
        {fmt(pt.rulesAt, { count: autoRules.length > 0 ? fmt(pt.rulesCount, { count: autoRules.length }) : "" })}{" "}
        <Link href="/tools/rules" className="text-primary underline-offset-2 hover:underline">
          {pt.rulesLink}
        </Link>
      </p>
    </details>
  );
}
