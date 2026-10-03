"use client";

// Settings > Profile > Payment methods: the list, reorder, remove with Undo; the dialog lives in payment/method-dialog.

import type { PaymentMethodsSetting } from "@yomi/contracts";
import { PAYMENT_METHODS_MAX, type PaymentMethod, resolveContact } from "@yomi/core/payment";
import { formatPhone } from "@yomi/core/phone";
import { ArrowDownIcon, ArrowUpIcon, PencilIcon, PlusIcon, QrCodeIcon, Trash2Icon } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { methodTitle, paymentKindIcon } from "@/components/payment/how-to-pay";
import { blank, type Draft, MethodDialog, toDraft } from "@/components/payment/method-dialog";
import { useProfileContact } from "@/components/profile-settings";
import { Dialog } from "@/components/ui/dialog";
import { Button } from "@/components/ui-kit/button";
import { IconTile } from "@/components/ui-kit/icon-tile";
import { ListCard } from "@/components/ui-kit/list-card";
import { fmt } from "@/i18n";
import { useT } from "@/i18n/client";
import { apiFetch } from "@/lib/api";

/** The contact values a method shows, for its list row: email, phone (`formatPhone`), username, text; profile values resolved. */
function contactSummary(m: PaymentMethod, profile: Parameters<typeof resolveContact>[1]): string[] {
  const c = resolveContact(m, profile);
  return [c.email, c.phone ? formatPhone(c.phone) : null, c.username, c.text].filter((v): v is string => Boolean(v));
}

/**
 * Settings > Profile > Payment methods: the list shown on statements under "My payment details" (at most 6), stored per user
 * through PUT /api/settings/payment-methods. Add or edit in a dialog, reorder with up / down, remove with Undo. Email
 * and phone come from the profile (ProfileContactProvider); rows show the resolved values.
 */
export function PaymentSettings({ initial }: { initial: PaymentMethod[] }) {
  const t = useT();
  const s = t.settings.payment;
  const { contact: profile } = useProfileContact();
  const [methods, setMethods] = useState(initial);
  const [editing, setEditing] = useState<{ index: number | null; key: number } | null>(null);
  const full = methods.length >= PAYMENT_METHODS_MAX;

  const put = async (next: PaymentMethod[]) => {
    const r = await apiFetch<PaymentMethodsSetting>("/settings/payment-methods", { method: "PUT", json: { methods: next } });
    setMethods(r.methods);
    return r.methods;
  };
  const optimistic = async (next: PaymentMethod[]) => {
    const prev = methods;
    setMethods(next);
    try {
      await put(next);
      return true;
    } catch {
      setMethods(prev);
      return false;
    }
  };
  const move = (i: number, delta: -1 | 1) => {
    const next = [...methods];
    [next[i], next[i + delta]] = [next[i + delta]!, next[i]!];
    void optimistic(next);
  };
  const remove = async (i: number) => {
    const prev = methods;
    if (await optimistic(methods.filter((_, j) => j !== i))) {
      toast.success(s.removed, { action: { label: t.common.undo, onClick: () => void put(prev).catch(() => undefined) } });
    }
  };
  const save = async (d: Draft, index: number | null) => {
    const m: PaymentMethod = {
      ...d,
      label: d.label.trim() || null,
      email: d.email.trim() || null,
      phone: d.phone.trim() || null,
      username: d.username.trim() || null,
      text: d.text.trim() || null,
    };
    try {
      await put(index === null ? [...methods, m] : methods.map((x, j) => (j === index ? m : x)));
    } catch {
      return false; // apiFetch showed the error; the dialog stays open
    }
    toast.success(s.saved);
    setEditing(null);
    return true;
  };
  const open = (index: number | null) => setEditing({ index, key: Date.now() });
  const current = editing?.index != null ? methods[editing.index] : undefined;

  return (
    <div className="flex flex-col gap-2" data-testid="payment-methods">
      <h3 className="text-body font-medium">{s.title}</h3>
      <p className="text-body text-2">{s.hint}</p>
      {methods.length > 0 && (
        <ListCard>
          <ul className="divide-y divide-line-soft">
            {methods.map((m, i) => {
              const title = methodTitle(t, m);
              const meta = [...contactSummary(m, profile), m.qr ? (m.display === "original" ? s.qrOriginal : s.qr) : "", m.currencies.join(", "), m.showOnStatement ? "" : s.hidden].filter(Boolean).join(" · ");
              return (
                <li key={i} className="flex min-h-14 items-center gap-3 px-4 py-2.5 md:px-5" data-testid="payment-method">
                  <IconTile icon={paymentKindIcon(m.kind)} />
                  <button type="button" className="min-w-0 flex-1 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring/50" onClick={() => open(i)}>
                    <span className="block truncate text-body font-medium">{title}</span>
                    <span className="flex items-center gap-1 text-meta text-2">
                      {m.qr && <QrCodeIcon className="size-3.5 shrink-0" aria-hidden />}
                      <span className="truncate">{meta}</span>
                    </span>
                  </button>
                  <div className="flex shrink-0 items-center gap-0.5">
                    <Button type="button" variant="ghost" size="icon-sm" aria-label={fmt(s.moveUp, { name: title })} disabled={i === 0} onClick={() => move(i, -1)}>
                      <ArrowUpIcon aria-hidden />
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-sm"
                      aria-label={fmt(s.moveDown, { name: title })}
                      disabled={i === methods.length - 1}
                      onClick={() => move(i, 1)}
                    >
                      <ArrowDownIcon aria-hidden />
                    </Button>
                    <Button type="button" variant="ghost" size="icon-sm" aria-label={fmt(s.edit, { name: title })} onClick={() => open(i)}>
                      <PencilIcon aria-hidden />
                    </Button>
                    <Button type="button" variant="ghost" size="icon-sm" aria-label={fmt(s.remove, { name: title })} onClick={() => void remove(i)}>
                      <Trash2Icon aria-hidden />
                    </Button>
                  </div>
                </li>
              );
            })}
          </ul>
        </ListCard>
      )}
      <div className="flex flex-wrap items-center gap-3">
        <Button type="button" variant="outline" disabled={full} onClick={() => open(null)}>
          <PlusIcon aria-hidden />
          {s.add}
        </Button>
        {full && <span className="text-meta text-2">{s.full}</span>}
      </div>
      <Dialog open={editing !== null} onOpenChange={(o) => !o && setEditing(null)}>
        {editing && (
          <MethodDialog
            key={editing.key}
            isNew={editing.index === null}
            initial={current ? toDraft(current) : blank()}
            onSave={(d) => save(d, editing.index)}
          />
        )}
      </Dialog>
    </div>
  );
}
