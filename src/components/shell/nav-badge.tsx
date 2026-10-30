"use client";

import type { NavBadgeKey } from "@/modules/operations/nav-badges";
import {
  badgeDescription,
  formatBadgeCount,
} from "@/modules/operations/nav-badges";
import { cn } from "@/lib/utils/cn";
import { useNavBadgeCount } from "./nav-badges-provider";

/** Frase do selo ("3 pedidos aguardando aceite") para dica e leitor de tela; vazio sem selo. */
export function useNavBadgeDescription(key: NavBadgeKey | undefined): string {
  const count = useNavBadgeCount(key);
  return key && count ? badgeDescription(key, count) : "";
}

type NavBadgeProps = {
  badge: NavBadgeKey | undefined;
  /** "inline": à direita do nome (barra aberta). "corner": no canto do ícone (recolhida e menu do celular). */
  placement: "inline" | "corner";
  className?: string;
};

/** Bolinha de contagem. Some com zero; acima de 99 mostra "99+". O texto para leitor de tela vem do link. */
export function NavBadge({ badge, placement, className }: NavBadgeProps) {
  const count = useNavBadgeCount(badge);
  const text = formatBadgeCount(count);
  if (!text) return null;
  return (
    <span
      aria-hidden="true"
      data-testid="nav-badge"
      className={cn(
        "grid place-items-center rounded-full bg-accent font-bold leading-none text-accent-fg tabular-nums",
        placement === "inline"
          ? "ml-auto h-[1.375rem] min-w-[1.375rem] px-1.5 text-xs"
          : "absolute right-0.5 top-0.5 h-5 min-w-5 px-1 text-[0.6875rem] ring-2 ring-surface",
        className,
      )}
    >
      {text}
    </span>
  );
}
