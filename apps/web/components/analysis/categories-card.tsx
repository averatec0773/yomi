"use client";

import { TagIcon } from "lucide-react";
import { type ReactNode, useState } from "react";
import { ListCard } from "@/components/ui-kit/list-card";
import { Segmented } from "@/components/ui-kit/segmented";
import { useT } from "@/i18n/client";

type View = "spending" | "income";

/** Categories of the period's spending, or of its income: a two-option switch in the card header, Spending first. */
export function CategoriesCard({ spending, income, code }: { spending: ReactNode; income: ReactNode; code?: ReactNode }) {
  const t = useT();
  const [view, setView] = useState<View>("spending");
  return (
    <ListCard
      icon={TagIcon}
      title={<>{t.analysis.categories}{code}</>}
      data-testid="categories-card"
      action={
        <Segmented<View>
          label={t.analysis.spendingOrIncome}
          value={view}
          onChange={setView}
          options={[
            { value: "spending", label: t.common.expense },
            { value: "income", label: t.common.income },
          ]}
        />
      }
    >
      {view === "spending" ? spending : income}
    </ListCard>
  );
}
