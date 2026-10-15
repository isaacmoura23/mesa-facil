"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import type { NavEntry } from "@/config/navigation";
import { cn } from "@/lib/utils/cn";
import { NAV_ICONS } from "./icons";

export function isActivePath(pathname: string, href: string): boolean {
  return pathname === href || pathname.startsWith(`${href}/`);
}

type SidebarNavProps = {
  items: readonly NavEntry[];
  label: string;
  onNavigate?: () => void;
};

/** Lista vertical de navegação (barra lateral e gaveta móvel). */
export function SidebarNav({ items, label, onNavigate }: SidebarNavProps) {
  const pathname = usePathname();

  return (
    <nav aria-label={label}>
      <ul className="flex flex-col gap-1">
        {items.map((item) => {
          const Icon = NAV_ICONS[item.icon];
          const active = isActivePath(pathname, item.href);
          return (
            <li key={item.href}>
              <Link
                href={item.href}
                onClick={onNavigate}
                aria-current={active ? "page" : undefined}
                className={cn(
                  "flex h-10 items-center gap-3 rounded-control px-3 text-sm font-medium transition-colors",
                  active
                    ? "bg-accent-soft text-accent-soft-fg"
                    : "text-muted hover:bg-surface-2 hover:text-fg",
                )}
              >
                <Icon aria-hidden="true" className="size-[1.125rem] shrink-0" />
                <span className="truncate">{item.label}</span>
                {item.readOnly ? (
                  <span className="ml-auto rounded-full border border-line px-2 text-[0.6875rem] leading-5 text-muted">
                    Leitura
                  </span>
                ) : null}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
