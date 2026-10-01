"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useT } from "@/i18n/client";

const UNDER_TOOLS = ["/split", "/import", "/tools/"];

/** "Tools" above the page title on pages reached from the Tools hub (/split, /import, /tools/*). Rendered by PageHeader. */
export function ToolsCrumb() {
  const pathname = usePathname();
  const t = useT();
  if (!UNDER_TOOLS.some((p) => pathname === p || pathname.startsWith(p.endsWith("/") ? p : `${p}/`))) return null;
  return (
    <nav aria-label={t.nav.breadcrumb} className="mb-0.5">
      <Link href="/tools" className="hit relative inline-block rounded-sm text-meta text-2 transition-colors duration-[120ms] hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring">
        {t.nav.toolsCrumb}
      </Link>
    </nav>
  );
}
