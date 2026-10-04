"use client";

import type { Identity, IdentityKind } from "@yomi/contracts";
import { PlusIcon, XIcon } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { KindIcon } from "@/components/split/identity-kinds";
import { NativeSelect } from "@/components/split/ui";
import { Button } from "@/components/ui-kit/button";
import { Input } from "@/components/ui/input";
import { fmt } from "@/i18n";
import { useT } from "@/i18n/client";
import { apiFetch } from "@/lib/api";

/** The kinds "me" can hold (core SELF_IDENTITY_KINDS). */
const KINDS: IdentityKind[] = ["bank_name", "zelle_name", "alipay", "wechat"];

/**
 * Settings > Profile "Names on my transfers": how the user's own name shows up on bank, Zelle, Alipay and WeChat
 * transfers (identities of the self participant). Money from or to one of them is proposed as an own-account transfer.
 * A list of names (kind icon, value, remove) and one add row: kind picker, name, Add (Enter adds too).
 */
export function TransferNames({ selfId, initial }: { selfId: number; initial: Identity[] }) {
  const t = useT();
  const s = t.settings.profile.transferNames;
  const [names, setNames] = useState(initial);
  const [kind, setKind] = useState<IdentityKind>("bank_name");
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);

  const add = async () => {
    const v = value.trim();
    if (!v || busy) return;
    setBusy(true);
    try {
      const added = await apiFetch<Identity>(`/participants/${selfId}/identities`, { json: { kind, value: v } });
      setNames((list) => (list.some((i) => i.id === added.id) ? list : [...list, added]));
      setValue("");
      toast.success(fmt(s.added, { value: added.value }));
    } catch {
      // apiFetch already showed the error.
    } finally {
      setBusy(false);
    }
  };

  const remove = async (i: Identity) => {
    setBusy(true);
    try {
      await apiFetch(`/identities/${i.id}`, { method: "DELETE" });
      setNames((list) => list.filter((x) => x.id !== i.id));
      toast(fmt(s.removed, { value: i.value }));
    } catch {
      // apiFetch already showed the error.
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mt-3 flex flex-col gap-2" data-testid="transfer-names">
      <h3 id="transfer-names-label" className="text-body font-medium">
        {s.title}
      </h3>
      <p className="text-body text-2">{s.hint}</p>
      {names.length > 0 ? (
        <ul className="flex flex-wrap gap-1.5" aria-labelledby="transfer-names-label">
          {names.map((i) => (
            <li key={i.id} className="inline-flex h-8 items-center gap-1.5 rounded-full bg-sunken pr-1 pl-3 text-meta">
              <KindIcon kind={i.kind} />
              <span className="text-2">{t.split.kinds[i.kind]}</span>
              <span>{i.value}</span>
              <button
                type="button"
                disabled={busy}
                onClick={() => void remove(i)}
                aria-label={fmt(s.removeAria, { value: i.value })}
                className="hit relative inline-flex size-6 items-center justify-center rounded-full text-2 hover:bg-border hover:text-foreground"
              >
                <XIcon className="size-3.5" aria-hidden />
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-meta text-3">{s.empty}</p>
      )}
      <div className="flex flex-wrap items-center gap-2 sm:max-w-xl">
        <NativeSelect value={kind} onChange={(e) => setKind(e.target.value as IdentityKind)} className="h-10 w-auto" aria-label={s.kind}>
          {KINDS.map((k) => (
            <option key={k} value={k}>
              {t.split.kinds[k]}
            </option>
          ))}
        </NativeSelect>
        <Input
          value={value}
          maxLength={120}
          placeholder={s.placeholder}
          aria-label={s.value}
          data-testid="transfer-name-input"
          className="h-10 min-w-0 flex-1 basis-48 text-body"
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              void add();
            }
          }}
        />
        <Button disabled={busy || !value.trim()} onClick={() => void add()}>
          <PlusIcon aria-hidden />
          {t.common.add}
        </Button>
      </div>
    </div>
  );
}
