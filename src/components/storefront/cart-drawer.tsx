"use client";

import { useEffect, useId, useRef, useState } from "react";
import Link from "next/link";
import { ShoppingBag, Trash2, X } from "lucide-react";
import { Button, buttonStyles } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { formatCents } from "@/lib/format";
import { estimatedLineCents, type CartLine } from "@/modules/storefront/cart";
import { useCart } from "@/modules/storefront/cart-context";
import { QuantityStepper } from "./quantity-stepper";

/** Linha do carrinho (nome, tamanho, adicionais, observação e valor estimado). */
export function CartLineSummary({ line }: { line: CartLine }) {
  return (
    <div className="min-w-0 flex-1">
      <p className="font-medium text-fg">{line.snapshot.name}</p>
      {line.snapshot.variantName ? (
        <p className="mt-0.5 text-sm text-muted">Tamanho: {line.snapshot.variantName}</p>
      ) : null}
      {line.snapshot.modifiers.length > 0 ? (
        <p className="mt-0.5 text-sm text-muted">
          {line.snapshot.modifiers.map((m) => m.name).join(", ")}
        </p>
      ) : null}
      {line.notes ? (
        <p className="mt-0.5 text-sm italic text-muted break-words">Obs.: {line.notes}</p>
      ) : null}
    </div>
  );
}

export function CartDrawer() {
  const cart = useCart();
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const [confirmClear, setConfirmClear] = useState(false);
  const { drawerOpen, closeDrawer } = cart;

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (drawerOpen && !dialog.open) dialog.showModal();
    if (!drawerOpen && dialog.open) dialog.close();
  }, [drawerOpen]);

  // Evita rolar a página por trás do painel aberto.
  useEffect(() => {
    if (!drawerOpen) return;
    const root = document.documentElement;
    const previous = root.style.overflow;
    root.style.overflow = "hidden";
    return () => {
      root.style.overflow = previous;
    };
  }, [drawerOpen]);

  const empty = cart.lines.length === 0;

  return (
    <>
      <dialog
        ref={ref}
        aria-labelledby={titleId}
        onClose={closeDrawer}
        onClick={(event) => {
          if (event.target === ref.current) closeDrawer();
        }}
        className="m-0 ml-auto h-dvh max-h-dvh w-full max-w-md border-l border-line bg-surface p-0 text-fg shadow-pop"
      >
        <div className="flex h-full flex-col">
          <div className="flex items-center justify-between gap-3 border-b border-line px-5 py-3">
            <h2 id={titleId} className="text-lg font-semibold">
              Seu carrinho
            </h2>
            <button
              type="button"
              onClick={closeDrawer}
              aria-label="Fechar carrinho"
              className="-mr-2 flex size-11 items-center justify-center rounded-control hover:bg-surface-2"
            >
              <X aria-hidden="true" className="size-5" />
            </button>
          </div>

          {empty ? (
            <div className="flex flex-1 flex-col items-center justify-center px-6 text-center">
              <span
                aria-hidden="true"
                className="mb-4 flex size-12 items-center justify-center rounded-control bg-accent-soft text-accent-soft-fg"
              >
                <ShoppingBag className="size-6" />
              </span>
              <p className="font-semibold">Seu carrinho está vazio</p>
              <p className="mt-1 max-w-xs text-sm text-muted">
                Escolha itens no cardápio e eles aparecem aqui.
              </p>
              <Button variant="secondary" className="mt-6" onClick={closeDrawer}>
                Voltar ao cardápio
              </Button>
            </div>
          ) : (
            <>
              <ul className="flex-1 divide-y divide-line overflow-y-auto overscroll-contain px-5">
                {cart.lines.map((line) => (
                  <li key={line.id} className="py-4">
                    <div className="flex gap-3">
                      <CartLineSummary line={line} />
                      <p className="shrink-0 text-sm font-semibold tabular-nums">
                        {formatCents(estimatedLineCents(line))}
                      </p>
                    </div>
                    <div className="mt-3 flex items-center justify-between gap-3">
                      <QuantityStepper
                        size="sm"
                        value={line.quantity}
                        label={line.snapshot.name}
                        onChange={(next) => cart.setQuantity(line.id, next)}
                      />
                      <button
                        type="button"
                        onClick={() => cart.removeLine(line.id)}
                        className="inline-flex h-9 items-center gap-1.5 rounded-control px-2 text-sm font-medium text-danger hover:bg-danger-soft"
                      >
                        <Trash2 aria-hidden="true" className="size-4" />
                        Remover
                        <span className="sr-only"> {line.snapshot.name}</span>
                      </button>
                    </div>
                  </li>
                ))}
              </ul>

              <div className="border-t border-line bg-surface px-5 pb-[max(1rem,env(safe-area-inset-bottom))] pt-4">
                <div className="flex items-baseline justify-between">
                  <span className="text-sm text-muted">Subtotal estimado</span>
                  <span className="text-lg font-semibold tabular-nums" aria-live="polite">
                    {formatCents(cart.estimatedSubtotalCents)}
                  </span>
                </div>
                <p className="mt-1 text-xs text-muted">
                  Valores conferidos pelo restaurante no checkout, com taxa de entrega se houver.
                </p>
                <div className="mt-4 flex flex-col gap-2">
                  <Link
                    href={`/r/${encodeURIComponent(cart.slug)}/checkout`}
                    onClick={closeDrawer}
                    className={buttonStyles({ size: "lg", fullWidth: true })}
                  >
                    Ir para o checkout
                  </Link>
                  <Button variant="ghost" onClick={() => setConfirmClear(true)}>
                    Limpar carrinho
                  </Button>
                </div>
              </div>
            </>
          )}
        </div>
      </dialog>

      <ConfirmDialog
        open={confirmClear}
        title="Limpar o carrinho?"
        description="Todos os itens serão removidos."
        confirmLabel="Limpar"
        tone="danger"
        onClose={() => setConfirmClear(false)}
        onConfirm={() => {
          cart.clear();
          setConfirmClear(false);
        }}
      />
    </>
  );
}
