import { mergeShortcuts, shortcutOverrides } from "@yomi/contracts/shortcuts";
import { getCurrentUser, getShortcutOverrides, getTheme, getTimeZoneSetting } from "@yomi/core";
import type { Metadata } from "next";
import { QuickAdd } from "@/components/quick-add";
import { BottomTabs } from "@/components/shell/bottom-tabs";
import { SIDEBAR_BOOT } from "@/components/shell/nav";
import { ShellKeys } from "@/components/shell/shell-keys";
import { ShortcutsSheet } from "@/components/shell/shortcuts-sheet";
import { Sidebar } from "@/components/shell/sidebar";
import { Toaster } from "@/components/ui/sonner";
import { I18nProvider } from "@/i18n/client";
import { getI18n } from "@/i18n/server";
import { getDb } from "@/lib/db";
import { ShortcutsProvider } from "@/lib/shortcuts";
import { ThemeProvider } from "@/lib/theme";
import { TimeZoneProvider } from "@/lib/time-zone";
import "./globals.css";

export async function generateMetadata(): Promise<Metadata> {
  const { t } = await getI18n();
  return { title: "yomi", description: t.nav.appDescription };
}

export default async function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  const { locale, t } = await getI18n();
  const db = await getDb();
  const user = getCurrentUser();
  const zone = await getTimeZoneSetting(db, user);
  const shortcuts = shortcutOverrides(mergeShortcuts(await getShortcutOverrides(db, user)));
  const theme = await getTheme(db, user);
  return (
    <html lang={locale} data-theme={theme === "system" ? undefined : theme} suppressHydrationWarning>
      <head>
        {/* Collapsed sidebar before first paint (localStorage); sets html[data-sidebar]. */}
        <script dangerouslySetInnerHTML={{ __html: SIDEBAR_BOOT }} />
      </head>
      <body className="min-h-screen">
        <I18nProvider locale={locale} t={t}>
          <ThemeProvider theme={theme}>
          <TimeZoneProvider timeZone={zone.timeZone} isSet={zone.isSet}>
          <ShortcutsProvider overrides={shortcuts}>
            <div className="md:flex">
              <div data-shell-chrome className="contents">
                <Sidebar />
              </div>
              <main className="min-w-0 flex-1 px-gutter pt-5 pb-[calc(112px+env(safe-area-inset-bottom))] md:px-10 md:pt-7 md:pb-16">
                <div className="mx-auto w-full max-w-list">{children}</div>
              </main>
            </div>
            <div data-shell-chrome className="contents">
              <BottomTabs />
              <QuickAdd />
            </div>
            <ShellKeys />
            <ShortcutsSheet />
            <Toaster position="bottom-center" mobileOffset={{ bottom: 100 }} expand />
          </ShortcutsProvider>
          </TimeZoneProvider>
          </ThemeProvider>
        </I18nProvider>
      </body>
    </html>
  );
}
