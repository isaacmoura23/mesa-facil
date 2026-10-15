"use client";

import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { Ellipsis, X } from "lucide-react";
import type { NavEntry } from "@/config/navigation";
import { cn } from "@/lib/utils/cn";
import { NAV_ICONS } from "./icons";
import { SidebarNav, isActivePath } from "./sidebar-nav";

const MAX_BAR_ITEMS = 5;

type MobileNavProps = {
  items: readonly NavEntry[];
  label: string;
  /** Conteúdo extra no fim da gaveta (ex.: link para outro ambiente). */
  drawerFooter?: ReactNode;
};

/**
 * Navegação inferior para telas pequenas. Com até 5 itens todos ficam na barra;
 * acima disso a barra mostra os 4 primeiros e "Mais" abre uma gaveta com tudo.
 */
export function MobileNav({ items, label, drawerFooter }: MobileNavProps) {
  const pathname = usePathname();
  const [drawerOpen, setDrawerOpen] = useState(false);
  const dialogRef = useRef<HTMLDialogElement>(null);
  const titleId = useId();

  const needsDrawer = items.length > MAX_BAR_ITEMS;
  const barItems = needsDrawer ? items.slice(0, MAX_BAR_ITEMS - 1) : items;
  const overflowActive =
    needsDrawer &&
    items.slice(MAX_BAR_ITEMS - 1).some((item) => isActivePath(pathname, item.href));

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (drawerOpen && !dialog.open) dialog.showModal();
    if (!drawerOpen && dialog.open) dialog.close();
  }, [drawerOpen]);

  const itemClass = (active: boolean) =>
    cn(
      "flex min-w-0 flex-1 flex-col items-center justify-center gap-1 px-1 py-2 text-[0.6875rem] font-medium leading-none transition-colors",
      active ? "text-accent-soft-fg" : "text-muted hover:text-fg",
    );

  return (
    <>
      <nav
        aria-label={label}
        className="fixed inset-x-0 bottom-0 z-30 border-t border-line bg-surface pb-[env(safe-area-inset-bottom)] lg:hidden"
      >
        <ul className="mx-auto flex max-w-xl items-stretch">
          {barItems.map((item) => {
            const Icon = NAV_ICONS[item.icon];
            const active = isActivePath(pathname, item.href);
            return (
              <li key={item.href} className="flex min-w-0 flex-1">
                <Link
                  href={item.href}
                  aria-current={active ? "page" : undefined}
                  className={itemClass(active)}
                >
                  <span
                    className={cn(
                      "flex h-7 w-12 items-center justify-center rounded-full transition-colors",
                      active && "bg-accent-soft",
                    )}
                  >
                    <Icon aria-hidden="true" className="size-5" />
                  </span>
                  <span className="max-w-full truncate">{item.label}</span>
                </Link>
              </li>
            );
          })}
          {needsDrawer ? (
            <li className="flex min-w-0 flex-1">
              <button
                type="button"
                onClick={() => setDrawerOpen(true)}
                aria-haspopup="dialog"
                aria-expanded={drawerOpen}
                className={itemClass(overflowActive)}
              >
                <span
                  className={cn(
                    "flex h-7 w-12 items-center justify-center rounded-full transition-colors",
                    overflowActive && "bg-accent-soft",
                  )}
                >
                  <Ellipsis aria-hidden="true" className="size-5" />
                </span>
                <span>Mais</span>
              </button>
            </li>
          ) : null}
        </ul>
      </nav>

      {needsDrawer ? (
        <dialog
          ref={dialogRef}
          aria-labelledby={titleId}
          onClose={() => setDrawerOpen(false)}
          onClick={(event) => {
            if (event.target === dialogRef.current) setDrawerOpen(false);
          }}
          className="m-0 mt-auto h-auto max-h-[85dvh] w-full max-w-none overflow-y-auto rounded-t-card border border-b-0 border-line bg-surface p-0 shadow-pop lg:hidden"
        >
          <div className="p-4 pb-[calc(1rem+env(safe-area-inset-bottom))]">
            <div className="mb-3 flex items-center justify-between">
              <h2 id={titleId} className="text-base font-semibold text-fg">
                Menu
              </h2>
              <button
                type="button"
                onClick={() => setDrawerOpen(false)}
                className="-m-2 rounded-control p-2 text-muted hover:bg-surface-2 hover:text-fg"
                aria-label="Fechar menu"
              >
                <X aria-hidden="true" className="size-5" />
              </button>
            </div>
            <SidebarNav
              items={items}
              label={`${label} (completa)`}
              onNavigate={() => setDrawerOpen(false)}
            />
            {drawerFooter ? (
              <div className="mt-4 border-t border-line pt-4">{drawerFooter}</div>
            ) : null}
          </div>
        </dialog>
      ) : null}
    </>
  );
}
