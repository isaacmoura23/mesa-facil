"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import type { NavEntry } from "@/config/navigation";
import { cn } from "@/lib/utils/cn";
import { NAV_ICONS } from "./icons";
import { NavBadge, useNavBadgeDescription } from "./nav-badge";

export function isActivePath(pathname: string, href: string): boolean {
  return pathname === href || pathname.startsWith(`${href}/`);
}

type SidebarNavProps = {
  items: readonly NavEntry[];
  label: string;
  onNavigate?: () => void;
  /** Só ícones; o nome aparece numa dica ao passar o mouse ou focar. */
  collapsed?: boolean;
};

/** Lista vertical de navegação (barra lateral recolhível e gaveta móvel). */
export function SidebarNav({ items, label, onNavigate, collapsed = false }: SidebarNavProps) {
  const pathname = usePathname();

  return (
    <nav aria-label={label}>
      <ul className="flex flex-col gap-1">
        {items.map((item) => (
          <SidebarItem
            key={item.href}
            item={item}
            active={isActivePath(pathname, item.href)}
            onNavigate={onNavigate}
            collapsed={collapsed}
          />
        ))}
      </ul>
    </nav>
  );
}

type SidebarItemProps = {
  item: NavEntry;
  active: boolean;
  onNavigate?: () => void;
  collapsed: boolean;
};

function SidebarItem({ item, active, onNavigate, collapsed }: SidebarItemProps) {
  const Icon = NAV_ICONS[item.icon];
  const badgeText = useNavBadgeDescription(item.badge);
  const label = badgeText ? `${item.label}: ${badgeText}` : item.label;
  return (
    <li>
      <Link
        href={item.href}
        onClick={onNavigate}
        aria-current={active ? "page" : undefined}
        aria-label={collapsed || badgeText ? label : undefined}
        className={cn(
          "group relative flex h-11 items-center gap-3 rounded-control px-3 text-sm font-medium transition-colors",
          collapsed && "justify-center px-0",
          active
            ? "bg-accent-soft text-accent-soft-fg"
            : "text-muted hover:bg-surface-2 hover:text-fg",
        )}
      >
        <Icon aria-hidden="true" className="size-[1.125rem] shrink-0" />
        {collapsed ? null : (
          <>
            <span className="truncate">{item.label}</span>
            {item.badge ? (
              <NavBadge badge={item.badge} placement="inline" />
            ) : item.readOnly ? (
              <span className="ml-auto rounded-full border border-line px-2 text-[0.6875rem] leading-5 text-muted">
                Leitura
              </span>
            ) : null}
          </>
        )}
        {collapsed && item.badge ? <NavBadge badge={item.badge} placement="corner" /> : null}
        {collapsed ? (
          <span
            role="tooltip"
            aria-hidden="true"
            className="pointer-events-none absolute left-full z-50 ml-3 whitespace-nowrap rounded-control bg-fg px-3 py-1.5 text-xs font-medium text-surface opacity-0 shadow-[var(--shadow-pop)] transition-opacity duration-150 group-hover:opacity-100 group-hover:delay-300 group-focus-visible:opacity-100"
          >
            {label}
            {item.readOnly ? " (leitura)" : ""}
          </span>
        ) : null}
      </Link>
    </li>
  );
}
