"use client";

import { useEffect, useMemo, useState } from "react";
import { toCheckoutItems, type CartLine } from "./cart";
import { quoteCartAction, type QuoteResult } from "./actions";
import type { Fulfillment } from "./schemas";

type Resolved = { key: string; result: QuoteResult };

/**
 * Pede ao servidor (`validate_cart` via Server Action) o recálculo do carrinho
 * a cada mudança relevante: itens, quantidades, adicionais, modalidade e zona.
 * Respostas fora de ordem são descartadas. Os valores exibidos vêm SEMPRE do
 * servidor; nada é calculado no cliente.
 */
export function useCartQuote(options: {
  slug: string;
  enabled: boolean;
  lines: CartLine[];
  fulfillment: Fulfillment;
  zoneId: string;
  /** Muda para forçar nova consulta (botão "tentar de novo"). */
  nonce?: number;
}) {
  const { slug, enabled, lines, fulfillment, zoneId, nonce = 0 } = options;

  const requestKey = useMemo(
    () =>
      JSON.stringify({
        slug,
        fulfillment,
        zoneId: fulfillment === "DELIVERY" && zoneId ? zoneId : null,
        items: toCheckoutItems(lines),
        nonce,
      }),
    [slug, fulfillment, zoneId, lines, nonce],
  );

  const [resolved, setResolved] = useState<Resolved | null>(null);
  const active = enabled && lines.length > 0;

  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    const timer = setTimeout(async () => {
      const { nonce: _nonce, ...payload } = JSON.parse(requestKey) as Record<string, unknown>;
      void _nonce;
      let result: QuoteResult;
      try {
        result = await quoteCartAction(payload);
      } catch {
        result = { status: "error", message: "Não foi possível conferir o pedido agora. Tente novamente em instantes." };
      }
      if (!cancelled) setResolved({ key: requestKey, result });
    }, 250);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [active, requestKey]);

  const current = active ? resolved : null;
  return {
    /** Última resposta recebida (pode ser de uma consulta anterior enquanto carrega). */
    result: current?.result ?? null,
    /** true enquanto a resposta mais recente ainda não chegou. */
    pending: active && resolved?.key !== requestKey,
  };
}
