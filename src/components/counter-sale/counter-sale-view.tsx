"use client";

import { useMemo, useRef, useState } from "react";
import { Search, ShoppingBag, Trash2, UtensilsCrossed } from "lucide-react";
import { ModalDialog } from "@/components/tables/modal-dialog";
import { ProductConfig } from "@/components/tables/product-config";
import { QuantityStepper } from "@/components/storefront/quantity-stepper";
import { ProductImage, hasProductImage } from "@/components/storefront/product-image";
import { Alert } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { inputStyles } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { formatCents } from "@/lib/format";
import { createClient } from "@/lib/supabase/client";
import { cn } from "@/lib/utils/cn";
import { createCounterSale, CounterSaleError, type CounterSaleResult } from "@/modules/counter-sale/rpc";
import { estimatedLineCents, type CartLineInput, type CartState } from "@/modules/storefront/cart";
import { hasVariants, isOrderable } from "@/modules/storefront/product";
import type { MenuProduct } from "@/modules/storefront/schemas";
import { normalizeText } from "@/modules/tables/format";
import {
  EMPTY_STAFF_CART,
  addToStaffCart,
  newAttemptKey,
  removeLine,
  setLineQuantity,
  staffCartCount,
  staffCartEstimate,
  toStaffPayload,
} from "@/modules/tables/staff-cart";
import { useStaffMenu } from "@/modules/tables/use-staff-menu";
import { CounterPaymentDialog } from "./counter-payment-dialog";

type CounterSaleViewProps = {
  slug: string;
  restaurantId: string;
};

/**
 * Venda de balcão (PDV). Esquerda: categorias e grade de produtos (um toque adiciona). Direita: pedido,
 * total grande e "Receber e finalizar". No celular o pedido abre por uma barra inferior.
 * O preço mostrado é uma estimativa: o servidor reprecifica tudo ao gravar a venda.
 */
export function CounterSaleView({ slug, restaurantId }: CounterSaleViewProps) {
  const menuState = useStaffMenu(slug, true);
  const supabase = useMemo(() => createClient(), []);
  const [cart, setCart] = useState<CartState>(EMPTY_STAFF_CART);
  const [category, setCategory] = useState("ALL");
  const [search, setSearch] = useState("");
  const [config, setConfig] = useState<MenuProduct | null>(null);
  const [showCart, setShowCart] = useState(false);
  const [paying, setPaying] = useState(false);
  const [sending, setSending] = useState(false);
  const [saleError, setSaleError] = useState<string | null>(null);
  const [done, setDone] = useState<CounterSaleResult | null>(null);
  // Uma chave por TENTATIVA: reenviar o mesmo pedido após falha de rede devolve a venda original.
  const attemptKeyRef = useRef<string | null>(null);

  const menu = menuState.menu;
  const count = staffCartCount(cart.lines);
  const total = staffCartEstimate(cart.lines);

  const categories = useMemo(() => (menu?.categories ?? []).filter((c) => c.products.length > 0), [menu]);
  const products = useMemo(() => {
    const query = normalizeText(search);
    return categories
      .filter((c) => category === "ALL" || c.id === category)
      .flatMap((c) => c.products)
      .filter((p) => (query ? normalizeText(p.name).includes(query) : true));
  }, [categories, category, search]);

  const inCart = useMemo(() => {
    const map = new Map<string, number>();
    for (const line of cart.lines) map.set(line.productId, (map.get(line.productId) ?? 0) + line.quantity);
    return map;
  }, [cart.lines]);

  function changed() {
    attemptKeyRef.current = null;
    setSaleError(null);
  }

  function add(line: CartLineInput) {
    changed();
    setDone(null);
    setCart((current) => addToStaffCart(current, line));
    setConfig(null);
  }

  function pick(product: MenuProduct) {
    if (!isOrderable(product)) return;
    if (hasVariants(product) || product.modifierGroups.length > 0) {
      setConfig(product);
      return;
    }
    add({
      productId: product.id,
      variantId: null,
      quantity: 1,
      modifierIds: [],
      notes: "",
      snapshot: {
        name: product.name,
        variantName: null,
        unitPriceCents: product.priceCents,
        imagePath: product.imagePath,
        modifiers: [],
      },
    });
  }

  function clearCart() {
    changed();
    setCart(EMPTY_STAFF_CART);
    setShowCart(false);
  }

  async function confirm(tenderedCents: number | null) {
    if (sending || cart.lines.length === 0) return;
    setSending(true);
    setSaleError(null);
    attemptKeyRef.current ??= newAttemptKey();
    try {
      const result = await createCounterSale(supabase, {
        restaurantId,
        items: toStaffPayload(cart.lines),
        tenderedCents,
        notes: null,
        idempotencyKey: attemptKeyRef.current,
      });
      attemptKeyRef.current = null;
      setDone(result);
      setCart(EMPTY_STAFF_CART);
      setPaying(false);
      setShowCart(false);
    } catch (cause) {
      const error = cause instanceof CounterSaleError ? cause : null;
      setSaleError(error?.message ?? "Não foi possível concluir a venda. Tente de novo.");
      // Item que saiu do ar: recarrega o cardápio para a equipe ver o que mudou.
      if (error?.code === "ITEMS_INVALID") {
        setPaying(false);
        menuState.reload();
      }
    } finally {
      setSending(false);
    }
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-4 lg:grid lg:grid-cols-[minmax(0,1fr)_24rem] lg:items-start">
      <section aria-label="Produtos" className={cn("min-w-0 flex-col gap-3 lg:flex", showCart ? "hidden" : "flex")}>
        {done ? (
          <Alert tone="success" title={`Venda #${done.orderNumber} registrada`}>
            <div className="flex flex-wrap items-center gap-x-6 gap-y-1">
              <span>
                Total <strong className="tabular-nums">{formatCents(done.totalCents)}</strong>
              </span>
              <span data-testid="sale-change">
                Troco <strong className="tabular-nums">{formatCents(done.changeCents)}</strong>
              </span>
              <span>O pedido já foi para a cozinha.</span>
              <Button size="sm" variant="secondary" onClick={() => setDone(null)}>
                Nova venda
              </Button>
            </div>
          </Alert>
        ) : null}

        <div className="space-y-3">
          <div className="relative">
            <Search aria-hidden="true" className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted" />
            <input
              type="search"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              aria-label="Buscar produto"
              placeholder="Buscar produto"
              className={inputStyles(false, "pl-9")}
            />
          </div>
          {categories.length > 1 ? (
            <div role="group" aria-label="Categorias" className="-mx-1 flex gap-2 overflow-x-auto px-1 pb-1">
              <CategoryTab active={category === "ALL"} onClick={() => setCategory("ALL")} label="Todos" />
              {categories.map((c) => (
                <CategoryTab key={c.id} active={category === c.id} onClick={() => setCategory(c.id)} label={c.name} />
              ))}
            </div>
          ) : null}
        </div>

        {menuState.loading && !menu ? (
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-4" aria-busy="true">
            {Array.from({ length: 8 }, (_, index) => (
              <Skeleton key={index} className="h-28 rounded-card" />
            ))}
          </div>
        ) : !menu ? (
          <Alert tone="danger" title="Não foi possível carregar o cardápio">
            <div className="flex flex-wrap items-center gap-3">
              <span>{menuState.error ?? "Erro inesperado."}</span>
              <Button size="sm" variant="secondary" onClick={menuState.reload}>
                Tentar de novo
              </Button>
            </div>
          </Alert>
        ) : products.length === 0 ? (
          <EmptyState
            icon={<UtensilsCrossed />}
            title={search ? "Nenhum produto encontrado" : "Cardápio vazio"}
            description={search ? "Revise a busca ou a categoria." : "Cadastre produtos no cardápio para vender no balcão."}
          />
        ) : (
          <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-4">
            {products.map((product) => (
              <ProductTile key={product.id} product={product} count={inCart.get(product.id) ?? 0} onPick={pick} />
            ))}
          </ul>
        )}

        <div className="sticky bottom-0 -mx-1 border-t border-line bg-bg/95 p-3 backdrop-blur lg:hidden">
          <Button size="lg" fullWidth onClick={() => setShowCart(true)} className="justify-between">
            <span className="inline-flex items-center gap-2">
              <ShoppingBag aria-hidden="true" className="size-4" />
              Ver pedido {count > 0 ? `(${count})` : ""}
            </span>
            <span className="tabular-nums">{formatCents(total)}</span>
          </Button>
        </div>
      </section>

      <aside
        aria-label="Pedido em montagem"
        className={cn(
          "flex-col overflow-hidden rounded-card border border-line bg-surface shadow-card lg:sticky lg:top-4 lg:flex lg:max-h-[calc(100dvh-8rem)]",
          showCart ? "flex" : "hidden",
        )}
      >
        <div className="flex items-center justify-between gap-2 border-b border-line px-4 py-3">
          <h2 className="text-base font-semibold text-fg">
            Pedido {count > 0 ? <span className="font-normal text-muted">({count} {count === 1 ? "item" : "itens"})</span> : null}
          </h2>
          <button
            type="button"
            onClick={() => setShowCart(false)}
            className="inline-flex h-10 items-center rounded-control px-2 text-sm font-medium text-muted hover:text-fg lg:hidden"
          >
            Voltar aos produtos
          </button>
        </div>

        <div className="min-h-40 flex-1 overflow-y-auto px-4 py-2">
          {cart.lines.length === 0 ? (
            <p className="py-10 text-center text-sm text-muted">Toque nos produtos para montar a venda.</p>
          ) : (
            <ul className="divide-y divide-line">
              {cart.lines.map((line) => (
                <li key={line.id} className="py-3">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="font-medium text-fg">
                        {line.snapshot.name}
                        {line.snapshot.variantName ? <span className="text-muted"> ({line.snapshot.variantName})</span> : null}
                      </p>
                      {line.snapshot.modifiers.length > 0 ? (
                        <p className="text-xs text-muted">+ {line.snapshot.modifiers.map((m) => m.name).join(", ")}</p>
                      ) : null}
                      {line.notes ? <p className="text-xs italic text-muted">Obs.: {line.notes}</p> : null}
                    </div>
                    <p className="shrink-0 text-sm font-semibold tabular-nums text-fg">{formatCents(estimatedLineCents(line))}</p>
                  </div>
                  <div className="mt-2 flex items-center justify-between">
                    <QuantityStepper
                      value={line.quantity}
                      onChange={(next) => {
                        changed();
                        setCart((current) => setLineQuantity(current, line.id, next));
                      }}
                      label={line.snapshot.name}
                      removeAtOne
                      size="sm"
                    />
                    <button
                      type="button"
                      onClick={() => {
                        changed();
                        setCart((current) => removeLine(current, line.id));
                      }}
                      aria-label={`Remover ${line.snapshot.name} do pedido`}
                      className="flex size-10 items-center justify-center rounded-control text-muted hover:bg-danger-soft hover:text-danger-soft-fg"
                    >
                      <Trash2 aria-hidden="true" className="size-4" />
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="space-y-3 border-t border-line bg-surface-2/60 px-4 py-4">
          {saleError ? (
            <Alert tone="danger" title="Venda não registrada">
              {saleError} O pedido continua aqui para você tentar de novo.
            </Alert>
          ) : null}
          <div>
            <p className="text-sm font-medium text-muted">Valor total</p>
            <p className="text-right text-4xl font-semibold tabular-nums text-fg" data-testid="sale-total">
              {formatCents(total)}
            </p>
          </div>
          <div className="grid grid-cols-2 gap-2">
            <Button variant="secondary" size="lg" disabled={cart.lines.length === 0 || sending} onClick={clearCart}>
              Cancelar
            </Button>
            <Button size="lg" disabled={cart.lines.length === 0 || sending} onClick={() => setPaying(true)}>
              Receber e finalizar
            </Button>
          </div>
          <p className="text-xs text-muted">O valor final é calculado pelo sistema ao registrar. A venda vai para a cozinha.</p>
        </div>
      </aside>

      <ModalDialog open={config !== null} title={config?.name ?? "Produto"} onClose={() => setConfig(null)}>
        {config ? <ProductConfig key={config.id} product={config} onBack={() => setConfig(null)} onAdd={add} /> : null}
      </ModalDialog>

      <CounterPaymentDialog
        open={paying}
        totalCents={total}
        sending={sending}
        error={saleError}
        onClose={() => setPaying(false)}
        onConfirm={(tendered) => void confirm(tendered)}
      />
    </div>
  );
}

function CategoryTab({ active, label, onClick }: { active: boolean; label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onClick}
      className={cn(
        "h-11 shrink-0 rounded-control border px-4 text-sm font-semibold uppercase tracking-wide transition-colors",
        active ? "border-accent bg-accent text-accent-fg" : "border-line bg-surface text-fg hover:border-line-strong hover:bg-surface-2",
      )}
    >
      {label}
    </button>
  );
}

function ProductTile({ product, count, onPick }: { product: MenuProduct; count: number; onPick: (product: MenuProduct) => void }) {
  const orderable = isOrderable(product);
  const image = hasProductImage(product.imagePath);
  return (
    <li>
      <button
        type="button"
        disabled={!orderable}
        onClick={() => onPick(product)}
        className={cn(
          "relative flex h-full min-h-28 w-full flex-col overflow-hidden rounded-card border border-line bg-surface text-left shadow-card transition-colors",
          orderable ? "hover:border-line-strong hover:bg-surface-2 active:translate-y-px" : "cursor-not-allowed opacity-55",
        )}
      >
        {image ? (
          <span className="relative block h-20 w-full bg-surface-2">
            <ProductImage path={product.imagePath} alt="" sizes="(min-width: 1280px) 160px, 40vw" className={cn(!orderable && "grayscale")} />
          </span>
        ) : null}
        <span className="flex flex-1 flex-col gap-1 p-3">
          <span className="line-clamp-2 text-sm font-semibold uppercase leading-snug text-fg">{product.name}</span>
          <span className="mt-auto text-sm font-semibold tabular-nums text-accent">
            {hasVariants(product) ? <span className="mr-1 text-xs font-normal text-muted">a partir de</span> : null}
            {formatCents(product.priceCents)}
          </span>
        </span>
        {count > 0 ? (
          <Badge tone="accent" className="absolute right-2 top-2">
            {count}
          </Badge>
        ) : null}
        {!orderable ? (
          <Badge tone="neutral" className="absolute right-2 top-2">
            Indisponível
          </Badge>
        ) : null}
      </button>
    </li>
  );
}
