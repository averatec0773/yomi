"use client";

import { BookOpenIcon } from "lucide-react";
import { Guide } from "@/components/bank/secret-form";
import { useT } from "@/i18n/client";

/** Public user guides, one per source. */
const GUIDES_BASE = "https://github.com/averatec0773/yomi/blob/main/guides";

const SOURCES = [
  { id: "alipay", file: "import-alipay.md" },
  { id: "wechat", file: "import-wechat.md" },
  { id: "icbc", file: "import-icbc.md" },
  { id: "boa", file: "import-boa.md" },
  { id: "sms", file: "import-icbc.md#sms-alerts" },
] as const;

/** "Where to get each file": one collapsed guide per source, ending with a link to the full guide on GitHub. */
export function SourceGuides() {
  const t = useT();
  const g = t.import.guides;
  return (
    <section aria-labelledby="import-guides" className="flex flex-col gap-3" data-testid="import-guides">
      <h2 id="import-guides" className="flex items-center gap-2 text-title font-semibold">
        <BookOpenIcon className="size-[18px] text-2" aria-hidden />
        {g.title}
      </h2>
      <div className="flex flex-col gap-2">
        {SOURCES.map(({ id, file }) => {
          const source = g[id];
          const labels: Record<string, string> = { guide: g.guideLink };
          const hrefs: Record<string, string> = { guide: `${GUIDES_BASE}/${file}` };
          if (id === "boa") {
            labels.boa = g.boa.boaLabel;
            hrefs.boa = "https://www.bankofamerica.com/";
          }
          return (
            <Guide
              key={id}
              testId={`import-guide-${id}`}
              title={source.title}
              steps={[...source.steps, g.fullGuide]}
              labels={labels}
              hrefs={hrefs}
              defaultOpen={false}
              checkedOn={null}
            />
          );
        })}
      </div>
    </section>
  );
}
