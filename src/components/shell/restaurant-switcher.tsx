"use client";

import { useCallback, useId, useRef, useState } from "react";
import Link from "next/link";
import { Check, ChevronsUpDown, Store } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils/cn";
import { useDismiss } from "./use-dismiss";

export type SwitcherItem = {
  slug: string;
  name: string;
  /** Destino ao escolher este restaurante. */
  href: string;
  pending?: boolean;
};

type RestaurantSwitcherProps = {
  currentSlug: string;
  currentName: string;
  items: readonly SwitcherItem[];
};

/** Seletor de restaurante. Com um único restaurante, mostra apenas o nome. */
export function RestaurantSwitcher({
  currentSlug,
  currentName,
  items,
}: RestaurantSwitcherProps) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const menuId = useId();
  const close = useCallback(() => setOpen(false), []);
  useDismiss(rootRef, open, close);

  const label = (
    <>
      <Store aria-hidden="true" className="size-4 shrink-0 text-muted" />
      <span className="truncate text-sm font-semibold text-fg">{currentName}</span>
    </>
  );

  if (items.length <= 1) {
    return <div className="flex min-w-0 items-center gap-2 px-1">{label}</div>;
  }

  return (
    <div ref={rootRef} className="relative min-w-0">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        aria-controls={menuId}
        aria-label={`Restaurante atual: ${currentName}. Trocar de restaurante`}
        className="flex h-10 max-w-full items-center gap-2 rounded-control px-2 transition-colors hover:bg-surface-2"
      >
        {label}
        <ChevronsUpDown aria-hidden="true" className="size-4 shrink-0 text-muted" />
      </button>

      <div
        id={menuId}
        hidden={!open}
        className={cn(
          "absolute left-0 z-40 mt-2 w-72 max-w-[calc(100vw-2rem)] rounded-card border border-line bg-surface p-2 shadow-pop",
          !open && "hidden",
        )}
      >
        <p className="px-3 py-2 text-xs font-medium text-muted">Seus restaurantes</p>
        <ul className="flex flex-col gap-1">
          {items.map((item) => {
            const current = item.slug === currentSlug;
            return (
              <li key={item.slug}>
                <Link
                  href={item.href}
                  onClick={close}
                  aria-current={current ? "true" : undefined}
                  className="flex min-h-10 items-center gap-2 rounded-control px-3 py-2 text-sm text-fg transition-colors hover:bg-surface-2"
                >
                  <span className="min-w-0 flex-1 truncate font-medium">{item.name}</span>
                  {item.pending ? <Badge tone="warning">Aguardando</Badge> : null}
                  {current ? (
                    <Check aria-hidden="true" className="size-4 shrink-0 text-accent" />
                  ) : null}
                </Link>
              </li>
            );
          })}
        </ul>
      </div>
    </div>
  );
}
