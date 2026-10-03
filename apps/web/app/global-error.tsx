"use client";

import { CircleAlertIcon, RotateCwIcon } from "lucide-react";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui-kit/button";
import { EmptyState } from "@/components/ui-kit/empty-state";
import { LOCALE_COOKIE } from "@/i18n/config";
import { type Dictionary, en } from "@/i18n/en";
import "./globals.css";

/**
 * The root layout itself threw (it reads the ledger for the theme, zone and shortcuts), so there is no shell, no
 * providers and no server data: its own document, the OS color scheme, and the locale cookie read here. Chinese is
 * loaded only when chosen, so English-only pages do not carry it.
 */
export default function GlobalError({ retry }: { retry: () => void }) {
  const [t, setT] = useState<Dictionary>(en);
  useEffect(() => {
    if (document.cookie.split("; ").includes(`${LOCALE_COOKIE}=zh-CN`)) void import("@/i18n/zh-CN").then((m) => setT(m.zhCN));
  }, []);
  return (
    <html lang={t === en ? "en" : "zh-CN"}>
      <body className="min-h-screen">
        <title>yomi</title>
        <main className="flex max-w-narrow flex-col gap-6 px-gutter pt-5 md:px-10 md:pt-7">
          <h1 className="text-page font-semibold tracking-[-0.01em]">{t.errorPage.title}</h1>
          <EmptyState
            icon={CircleAlertIcon}
            action={
              <Button onClick={retry}>
                <RotateCwIcon aria-hidden />
                {t.common.retry}
              </Button>
            }
          >
            {t.errorPage.body}
          </EmptyState>
        </main>
      </body>
    </html>
  );
}
