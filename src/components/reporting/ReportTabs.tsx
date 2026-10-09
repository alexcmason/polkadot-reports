"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

export type Tab = { href: string; label: string; count?: number };

/** Section tabs under the report header. The first tab (overview) is only active on its own page. */
export function ReportTabs({ tabs }: { tabs: Tab[] }) {
  const path = usePathname();
  return (
    <nav className="tabs" aria-label="Report sections">
      {tabs.map((t, i) => {
        const active = i === 0 ? path === t.href : path === t.href || path.startsWith(`${t.href}/`);
        return (
          <Link key={t.href} href={t.href} className={active ? "active" : undefined} aria-current={active ? "page" : undefined}>
            {t.label}
            {t.count ? <span className="count">{t.count}</span> : null}
          </Link>
        );
      })}
    </nav>
  );
}
