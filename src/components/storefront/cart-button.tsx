"use client";

import { usePathname } from "next/navigation";
import { ShoppingBag } from "lucide-react";
import { formatCents } from "@/lib/format";
import { useCart } from "@/modules/storefront/cart-context";

/** Ícone do carrinho no cabeçalho, com contagem de unidades. */
export function CartButton() {
  const { count, ready, openDrawer } = useCart();
  const shown = ready ? count : 0;
  return (
    <button
      type="button"
      onClick={openDrawer}
      aria-haspopup="dialog"
      aria-label={
        shown > 0
          ? `Abrir carrinho, ${shown} ${shown === 1 ? "item" : "itens"}`
          : "Abrir carrinho, vazio"
      }
      className="relative flex size-11 items-center justify-center rounded-control text-fg transition-colors hover:bg-surface-2"
    >
      <ShoppingBag aria-hidden="true" className="size-5" />
      {shown > 0 ? (
        <span
          aria-hidden="true"
          className="absolute right-0.5 top-0.5 flex min-w-5 items-center justify-center rounded-full bg-accent px-1 text-xs font-semibold leading-5 text-accent-fg"
        >
          {shown > 99 ? "99+" : shown}
        </span>
      ) : null}
    </button>
  );
}

/**
 * Barra flutuante "ver carrinho" (cardápio). O valor é uma ESTIMATIVA feita
 * com os preços vistos no momento da adição; o total oficial vem do servidor
 * no checkout.
 */
export function FloatingCartBar() {
  const pathname = usePathname();
  const { count, ready, estimatedSubtotalCents, openDrawer } = useCart();
  const hiddenHere = pathname.includes("/produto/") || pathname.endsWith("/checkout");
  if (!ready || count === 0 || hiddenHere) return null;

  return (
    <div className="pointer-events-none fixed inset-x-0 bottom-0 z-30 px-4 pb-[max(1rem,env(safe-area-inset-bottom))]">
      <button
        type="button"
        onClick={openDrawer}
        aria-haspopup="dialog"
        className="pointer-events-auto mx-auto flex h-14 w-full max-w-md items-center justify-between gap-3 rounded-card bg-accent px-5 text-accent-fg shadow-pop transition-colors hover:bg-accent-hover active:translate-y-px"
      >
        <span className="flex items-center gap-2.5 text-sm font-semibold">
          <ShoppingBag aria-hidden="true" className="size-5" />
          Ver carrinho ({count} {count === 1 ? "item" : "itens"})
        </span>
        <span className="text-sm font-semibold tabular-nums">
          <span className="sr-only">Estimado: </span>
          {formatCents(estimatedSubtotalCents)}
        </span>
      </button>
    </div>
  );
}
