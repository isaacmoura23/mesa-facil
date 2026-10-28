"use client";

import { useState, type ReactNode } from "react";
import { PanelLeft } from "lucide-react";
import type { NavEntry } from "@/config/navigation";
import { BrandMark } from "@/components/brand-mark";
import { cn } from "@/lib/utils/cn";
import { SidebarNav } from "./sidebar-nav";

type DesktopSidebarProps = {
  areaLabel: string;
  nav: readonly NavEntry[];
  navLabel: string;
  navFooter?: ReactNode;
};

/**
 * Barra lateral flutuante de telas grandes. Recolhe para só ícones (com dica
 * ao passar o mouse). Os itens já chegam filtrados pelas permissões.
 */
export function DesktopSidebar({ areaLabel, nav, navLabel, navFooter }: DesktopSidebarProps) {
  const [open, setOpen] = useState(true);

  return (
    <aside
      className={cn(
        "hidden shrink-0 lg:sticky lg:top-0 lg:flex lg:h-dvh lg:p-6 transition-[width] duration-300 ease-out",
        open ? "lg:w-[19.5rem]" : "lg:w-[8.25rem]",
      )}
    >
      {/* Recolhido, a dica de cada ícone sai do cartão: não pode ser cortada. */}
      <div
        className={cn(
          "flex h-full min-h-0 w-full flex-col gap-4 rounded-3xl border border-line bg-surface p-4 shadow-[var(--shadow-pop)]",
          open ? "overflow-hidden" : "overflow-visible",
        )}
      >
        <div className={cn("flex shrink-0 items-center", open ? "justify-between" : "flex-col gap-3")}>
          <BrandMark href="/entrar" compact={!open} />
          <button
            type="button"
            onClick={() => setOpen((value) => !value)}
            aria-expanded={open}
            aria-label={open ? "Recolher menu" : "Expandir menu"}
            className="grid size-11 shrink-0 place-items-center rounded-control text-muted transition-colors hover:bg-accent-soft hover:text-accent-soft-fg"
          >
            <PanelLeft aria-hidden="true" className="size-[1.125rem]" />
          </button>
        </div>

        <div
          className={cn(
            "min-h-0 flex-1 px-1 py-2",
            open ? "overflow-y-auto overflow-x-hidden" : "overflow-visible",
          )}
        >
          <p
            className={cn(
              "mb-2 px-3 text-xs font-medium text-muted transition-opacity duration-200",
              open ? "opacity-100" : "sr-only",
            )}
          >
            {areaLabel}
          </p>
          <SidebarNav items={nav} label={navLabel} collapsed={!open} />
        </div>

        {navFooter ? (
          <div
            className={cn(
              "shrink-0 border-t border-line pt-3",
              // Recolhido: o texto do botão some e fica só o ícone.
              !open && "[&_a]:justify-center [&_a]:px-0 [&_a]:text-[0px]",
            )}
          >
            {navFooter}
          </div>
        ) : null}
      </div>
    </aside>
  );
}
