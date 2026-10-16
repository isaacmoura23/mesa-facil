"use client";

import { useMemo, useRef, useState } from "react";
import { ShoppingBag } from "lucide-react";
import { Button } from "@/components/ui/button";
import { formatCents } from "@/lib/format";
import { cn } from "@/lib/utils/cn";
import type { CartLineInput, CartState } from "@/modules/storefront/cart";
import type { MenuProduct } from "@/modules/storefront/schemas";
import {
  EMPTY_STAFF_CART,
  newAttemptKey,
  addToStaffCart,
  removeLine,
  setLineQuantity,
  staffCartCount,
  staffCartEstimate,
  toStaffPayload,
} from "@/modules/tables/staff-cart";
import type { ActionResult } from "@/modules/tables/use-tab-actions";
import type { StaffCartItemPayload } from "@/modules/tables/types";
import { useStaffMenu } from "@/modules/tables/use-staff-menu";
import { MenuPicker } from "./menu-picker";
import { ModalDialog } from "./modal-dialog";
import { ProductConfig } from "./product-config";
import { StaffCartPanel } from "./staff-cart-panel";

type AddItemsDialogProps = {
  open: boolean;
  slug: string;
  destination: string;
  sending: boolean;
  onClose: () => void;
  /** Envia o pedido; o resultado decide se o carrinho é limpo. */
  onSend: (items: StaffCartItemPayload[], notes: string | null, idempotencyKey: string) => Promise<ActionResult | null>;
};

/**
 * Lançamento de itens: cardápio completo à esquerda, pedido à direita (em
 * telas estreitas, o pedido abre por uma barra inferior). O carrinho é local
 * e sobrevive a fechar/abrir o seletor; só é limpo após o envio com sucesso.
 */
export function AddItemsDialog({ open, slug, destination, sending, onClose, onSend }: AddItemsDialogProps) {
  const menuState = useStaffMenu(slug, open);
  const [cart, setCart] = useState<CartState>(EMPTY_STAFF_CART);
  const [orderNotes, setOrderNotes] = useState("");
  const [config, setConfig] = useState<MenuProduct | null>(null);
  const [showCart, setShowCart] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  // Uma chave por TENTATIVA: reenviar o mesmo carrinho após falha reusa a chave
  // (o servidor devolve o pedido original); qualquer mudança no carrinho ou um
  // sucesso gera chave nova.
  const attemptKeyRef = useRef<string | null>(null);
  const resetAttempt = () => {
    attemptKeyRef.current = null;
  };

  const count = staffCartCount(cart.lines);
  const estimate = staffCartEstimate(cart.lines);

  const inCart = useMemo(() => {
    const map = new Map<string, number>();
    for (const line of cart.lines) map.set(line.productId, (map.get(line.productId) ?? 0) + line.quantity);
    return map;
  }, [cart.lines]);

  function add(line: CartLineInput) {
    resetAttempt();
    setCart((current) => addToStaffCart(current, line));
    setConfig(null);
    setSendError(null);
  }

  async function send() {
    if (sending || cart.lines.length === 0) return;
    setSendError(null);
    attemptKeyRef.current ??= newAttemptKey();
    const result = await onSend(toStaffPayload(cart.lines), orderNotes.trim() || null, attemptKeyRef.current);
    if (!result) return; // clique duplo ignorado
    if (result.ok) {
      resetAttempt();
      setCart(EMPTY_STAFF_CART);
      setOrderNotes("");
      setConfig(null);
      setShowCart(false);
    } else {
      setSendError(result.error.message);
    }
  }

  function close() {
    setConfig(null);
    setShowCart(false);
    onClose();
  }

  return (
    <ModalDialog
      open={open}
      variant="sheet"
      title="Adicionar itens"
      description={`Pedido para ${destination}`}
      onClose={close}
      locked={sending}
    >
      <div className="flex min-h-0 flex-1 lg:grid lg:grid-cols-[minmax(0,1fr)_22rem]">
        <section
          aria-label="Cardápio"
          className={cn("min-h-0 min-w-0 flex-1 flex-col lg:flex lg:border-r lg:border-line", showCart ? "hidden" : "flex")}
        >
          {config ? (
            <ProductConfig key={config.id} product={config} onBack={() => setConfig(null)} onAdd={add} />
          ) : (
            <>
              <MenuPicker
                menu={menuState.menu}
                loading={menuState.loading}
                error={menuState.error}
                onRetry={menuState.reload}
                onPick={setConfig}
                inCart={inCart}
              />
              <div className="border-t border-line bg-surface p-3 lg:hidden">
                <Button size="lg" fullWidth onClick={() => setShowCart(true)} className="justify-between">
                  <span className="inline-flex items-center gap-2">
                    <ShoppingBag aria-hidden="true" className="size-4" />
                    Ver pedido {count > 0 ? `(${count})` : ""}
                  </span>
                  <span className="tabular-nums">{formatCents(estimate)}</span>
                </Button>
              </div>
            </>
          )}
        </section>

        <section
          aria-label="Pedido em montagem"
          className={cn("min-h-0 min-w-0 flex-1 flex-col lg:flex lg:flex-none", showCart ? "flex" : "hidden")}
        >
          <div className="border-b border-line px-5 py-2 lg:hidden">
            <button
              type="button"
              onClick={() => setShowCart(false)}
              className="-ml-2 inline-flex h-10 items-center rounded-control px-2 text-sm font-medium text-muted hover:text-fg"
            >
              Voltar ao cardápio
            </button>
          </div>
          <StaffCartPanel
            lines={cart.lines}
            orderNotes={orderNotes}
            onOrderNotesChange={(value) => {
              resetAttempt();
              setOrderNotes(value);
            }}
            onQuantity={(id, quantity) => {
              resetAttempt();
              setCart((current) => setLineQuantity(current, id, quantity));
            }}
            onRemove={(id) => {
              resetAttempt();
              setCart((current) => removeLine(current, id));
            }}
            onClear={() => {
              resetAttempt();
              setCart(EMPTY_STAFF_CART);
              setSendError(null);
            }}
            onSend={() => void send()}
            sending={sending}
            sendError={sendError}
            destination={destination}
          />
        </section>
      </div>
    </ModalDialog>
  );
}
