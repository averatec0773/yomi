"use client";

import type { Settlement } from "@yomi/contracts";
import { toast } from "sonner";
import { getClientDictionary } from "@/i18n/client";
import { apiFetch } from "@/lib/api";

/** Success toast for a new settlement with a one-tap undo (deletes it again). */
export function settlementToast(message: string, s: Settlement, refresh: () => void): void {
  const t = getClientDictionary();
  toast.success(message, {
    action: {
      label: t.common.undo,
      onClick: async () => {
        try {
          await apiFetch(`/settlements/${s.id}`, { method: "DELETE" });
          toast(t.split.undone);
          refresh();
        } catch {
          /* apiFetch toasted */
        }
      },
    },
  });
}
