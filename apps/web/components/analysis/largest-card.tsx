"use client";

import { ArrowDownWideNarrowIcon, StoreIcon } from "lucide-react";
import { type ReactNode, useState } from "react";
import { ListCard } from "@/components/ui-kit/list-card";
import { Segmented } from "@/components/ui-kit/segmented";
import { useT } from "@/i18n/client";

type View = "largest" | "merchants";

/** The largest rows of the period, or its top merchants: a two-option switch in the card header, Largest first. */
export function LargestCard({ largest, merchants, code }: { largest: ReactNode; merchants: ReactNode; code?: ReactNode }) {
  const t = useT();
  const [view, setView] = useState<View>("largest");
  const Icon = view === "largest" ? ArrowDownWideNarrowIcon : StoreIcon;
  return (
    <ListCard aria-label={view === "largest" ? t.analysis.largest : t.analysis.topMerchants} data-testid="largest-card">
      <div className="flex min-h-12 items-center gap-2.5 px-4 py-2 md:px-5">
        <Icon aria-hidden className="size-[18px] shrink-0 text-2" />
        <Segmented<View>
          label={t.analysis.largestOrMerchants}
          value={view}
          onChange={setView}
          options={[
            { value: "largest", label: t.analysis.largest },
            { value: "merchants", label: t.analysis.topMerchants },
          ]}
        />
        {code}
      </div>
      {view === "largest" ? largest : merchants}
    </ListCard>
  );
}
