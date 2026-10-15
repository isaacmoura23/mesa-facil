"use client";

import Link from "next/link";
import { RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Spinner } from "@/components/ui/spinner";
import { formatCents } from "@/lib/format";
import { cn } from "@/lib/utils/cn";
import type { CartLine } from "@/modules/storefront/cart";
import { useCart } from "@/modules/storefront/cart-context";
import { VARIANT_FIX_CODES, cartErrorMessage } from "@/modules/storefront/messages";
import type { QuoteResult } from "@/modules/storefront/actions";
import type { Fulfillment } from "@/modules/storefront/schemas";
import { CartLineSummary } from "./cart-drawer";
import { QuantityStepper } from "./quantity-stepper";

type CheckoutSummaryProps = {
  lines: CartLine[];
  result: QuoteResult | null;
  pending: boolean;
  fulfillment: Fulfillment;
  zoneChosen: boolean;
  onRetry: () => void;
};

function Row({ label, value, strong }: { label: string; value: string; strong?: boolean }) {
  return (
    <div className={cn("flex items-baseline justify-between gap-3", strong ? "text-base" : "text-sm")}>
      <dt className={strong ? "font-semibold text-fg" : "text-muted"}>{label}</dt>
      <dd className={cn("tabular-nums", strong ? "text-lg font-semibold text-fg" : "text-fg")}>{value}</dd>
    </div>
  );
}

/**
 * Resumo do pedido. Subtotal, taxa e total vêm do servidor (`validate_cart`);
 * a lista de itens vem do carrinho local. Erros são mostrados em PT-BR a
 * partir do código, por item quando houver `item_index`.
 */
export function CheckoutSummary({
  lines,
  result,
  pending,
  fulfillment,
  zoneChosen,
  onRetry,
}: CheckoutSummaryProps) {
  const cart = useCart();
  const quote = result?.status === "ok" ? result.quote : null;

  // `items` do servidor traz só as linhas SEM erro, em ordem: casa com as linhas
  // do carrinho que não aparecem em nenhum erro por item.
  const erroredIndexes = new Set(
    (quote?.errors ?? []).flatMap((e) => (e.itemIndex === null ? [] : [e.itemIndex])),
  );
  const serverLineFor = new Map<number, NonNullable<typeof quote>["items"][number]>();
  if (quote) {
    let next = 0;
    lines.forEach((line, index) => {
      if (erroredIndexes.has(index)) return;
      const candidate = quote.items[next];
      if (candidate && candidate.productId === line.productId) serverLineFor.set(index, candidate);
      next += 1;
    });
  }

  // Antes de escolher a região, "ZONE_REQUIRED" é só uma pendência do formulário.
  const errors = (quote?.errors ?? []).filter(
    (e) => !(e.code === "ZONE_REQUIRED" && !zoneChosen),
  );
  const generalErrors = errors.filter((e) => e.itemIndex === null);
  const itemErrors = (index: number) => errors.filter((e) => e.itemIndex === index);
  const messageFor = (code: string): string =>
    code === "BELOW_MINIMUM" && quote && quote.minimumOrderCents > 0
      ? `${cartErrorMessage(code)} Pedido mínimo: ${formatCents(quote.minimumOrderCents)}.`
      : cartErrorMessage(code);

  return (
    <Card as="section" aria-labelledby="resumo-titulo" className="lg:sticky lg:top-20">
      <h2 id="resumo-titulo" className="text-base font-semibold text-fg">
        Resumo do pedido
      </h2>

      <ul className="mt-2 divide-y divide-line">
        {lines.map((line, index) => {
          const serverLine = serverLineFor.get(index);
          const lineErrors = itemErrors(index);
          return (
            <li key={line.id} className="py-3">
              <div className="flex gap-3">
                <CartLineSummary line={line} />
                {serverLine && !pending ? (
                  <p className="shrink-0 text-sm font-semibold tabular-nums">
                    {formatCents(serverLine.lineTotalCents)}
                  </p>
                ) : null}
              </div>
              {lineErrors.length > 0 ? (
                <ul className="mt-2 space-y-1">
                  {lineErrors.map((e) => (
                    <li key={e.code} className="text-sm font-medium text-danger">
                      {messageFor(e.code)}
                    </li>
                  ))}
                </ul>
              ) : null}
              {lineErrors.some((e) => VARIANT_FIX_CODES.has(e.code)) ? (
                <Link
                  href={`/r/${encodeURIComponent(cart.slug)}/produto/${line.productId}`}
                  className="mt-2 inline-flex h-9 items-center rounded-control px-2 text-sm font-medium text-accent hover:bg-accent-soft"
                >
                  Escolher tamanho
                  <span className="sr-only"> de {line.snapshot.name}</span>
                </Link>
              ) : null}
              <div className="mt-2 flex items-center justify-between gap-3">
                <QuantityStepper
                  size="sm"
                  value={line.quantity}
                  label={line.snapshot.name}
                  onChange={(next) => cart.setQuantity(line.id, next)}
                />
                <button
                  type="button"
                  onClick={() => cart.removeLine(line.id)}
                  className="h-9 rounded-control px-2 text-sm font-medium text-danger hover:bg-danger-soft"
                >
                  Remover<span className="sr-only"> {line.snapshot.name}</span>
                </button>
              </div>
            </li>
          );
        })}
      </ul>

      <div aria-live="polite" aria-atomic="false" className="mt-2 border-t border-line pt-4">
        {generalErrors.length > 0 ? (
          <ul
            className="mb-4 space-y-1.5 rounded-control bg-danger-soft px-4 py-3 text-sm font-medium text-danger-soft-fg"
            aria-label="Problemas com o pedido"
          >
            {generalErrors.map((e) => (
              <li key={e.code}>{messageFor(e.code)}</li>
            ))}
          </ul>
        ) : null}

        {result?.status === "error" ? (
          <div className="mb-4 rounded-control bg-danger-soft px-4 py-3 text-sm text-danger-soft-fg">
            <p className="font-medium">{result.message}</p>
            <Button variant="secondary" size="sm" className="mt-3" onClick={onRetry}>
              <RefreshCw aria-hidden="true" className="size-4" />
              Tentar de novo
            </Button>
          </div>
        ) : null}

        {quote ? (
          <dl className={cn("space-y-2 transition-opacity", pending && "opacity-60")}>
            <Row label="Subtotal" value={formatCents(quote.subtotalCents)} />
            {fulfillment === "DELIVERY" ? (
              <Row
                label="Taxa de entrega"
                value={zoneChosen ? formatCents(quote.deliveryFeeCents) : "Escolha a região"}
              />
            ) : null}
            {quote.discountCents > 0 ? (
              <Row label="Desconto" value={`- ${formatCents(quote.discountCents)}`} />
            ) : null}
            <div className="border-t border-line pt-3">
              <Row label="Total" value={formatCents(quote.totalCents)} strong />
            </div>
          </dl>
        ) : result?.status === "error" ? null : (
          <p className="flex items-center gap-2 text-sm text-muted">
            <Spinner decorative />
            Calculando valores
          </p>
        )}

        {quote && pending ? (
          <p className="mt-2 flex items-center gap-2 text-xs text-muted">
            <Spinner decorative className="size-3" />
            Atualizando valores
          </p>
        ) : null}
        <p className="mt-3 text-xs text-muted">
          Valores calculados pelo restaurante. Podem mudar se o cardápio for atualizado.
        </p>
      </div>
    </Card>
  );
}
