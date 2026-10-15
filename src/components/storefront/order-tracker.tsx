"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { RefreshCw, WifiOff } from "lucide-react";
import { Alert } from "@/components/ui/alert";
import { Button, buttonStyles } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import type { TrackedOrder } from "@/modules/orders-server/tracking";
import { trackOrderAction } from "@/modules/storefront/order-actions";
import { rememberOrder } from "@/modules/storefront/order-checkout";
import {
  TERMINAL_STATUSES,
  formatClock,
  statusHeadline,
} from "@/modules/storefront/order-status";
import { OrderDetails } from "./order-details";
import { OrderTimeline } from "./order-timeline";

/** Intervalo normal de atualização e teto do recuo em caso de erro. */
const POLL_MS = 12_000;
const MAX_BACKOFF_MS = 60_000;

type OrderTrackerProps = {
  slug: string;
  publicCode: string;
  initial: TrackedOrder;
};

/**
 * Acompanhamento do pedido. Faz polling pela Server Action (a vitrine padrão
 * não usa Realtime: o cliente é anônimo). Regras: pausa com a aba oculta (e
 * atualiza ao voltar), recua (12 s -> 60 s) em erro e para ao chegar num
 * estado final.
 */
export function OrderTracker({ slug, publicCode, initial }: OrderTrackerProps) {
  const [order, setOrder] = useState(initial);
  const [failures, setFailures] = useState(0);
  const [checkedAt, setCheckedAt] = useState<string>(() => new Date().toISOString());
  const [refreshing, setRefreshing] = useState(false);
  const [gone, setGone] = useState(false);
  const failuresRef = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const busy = useRef(false);
  const terminal = TERMINAL_STATUSES.has(order.status);

  // Guarda o pedido nos "recentes" do navegador (também ao abrir por link).
  useEffect(() => {
    rememberOrder({
      slug,
      publicCode,
      orderNumber: initial.orderNumber,
      at: initial.createdAt ?? new Date().toISOString(),
    });
  }, [slug, publicCode, initial.orderNumber, initial.createdAt]);

  const refresh = useCallback(async (): Promise<boolean> => {
    if (busy.current) return false;
    busy.current = true;
    try {
      const result = await trackOrderAction(slug, publicCode);
      if (result.status === "ok") {
        failuresRef.current = 0;
        setFailures(0);
        setOrder(result.order);
        setCheckedAt(new Date().toISOString());
        return true;
      }
      if (result.status === "not_found") {
        setGone(true);
        return true;
      }
      throw new Error(result.status);
    } catch {
      failuresRef.current += 1;
      setFailures(failuresRef.current);
      return false;
    } finally {
      busy.current = false;
    }
  }, [slug, publicCode]);

  useEffect(() => {
    if (terminal || gone) return;
    let cancelled = false;

    const schedule = () => {
      if (cancelled) return;
      if (timer.current) clearTimeout(timer.current);
      if (document.visibilityState === "hidden") return; // retoma no visibilitychange
      const delay = Math.min(POLL_MS * 2 ** failuresRef.current, MAX_BACKOFF_MS);
      timer.current = setTimeout(async () => {
        await refresh();
        schedule();
      }, delay);
    };

    const onVisibility = () => {
      if (document.visibilityState === "visible") {
        if (timer.current) clearTimeout(timer.current);
        void refresh().then(schedule);
      } else if (timer.current) {
        clearTimeout(timer.current);
      }
    };

    schedule();
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      cancelled = true;
      if (timer.current) clearTimeout(timer.current);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [terminal, gone, refresh]);

  async function manualRefresh() {
    setRefreshing(true);
    await refresh();
    setRefreshing(false);
  }

  const menuHref = `/r/${encodeURIComponent(slug)}`;
  const failed = order.status === "REJECTED" || order.status === "CANCELLED";

  return (
    <div className="mx-auto max-w-3xl">
      <p className="text-sm text-muted">{order.restaurantName}</p>
      <h1 className="mt-1 text-2xl font-semibold tracking-tight text-fg">Pedido nº {order.orderNumber}</h1>

      <div className="mt-4" aria-live="polite" aria-atomic="true">
        <Alert tone={failed ? "danger" : order.status === "COMPLETED" ? "success" : "info"} title={statusHeadline(order.status, order.fulfillmentType)}>
          {failed && order.statusReason ? <>Motivo informado pelo restaurante: {order.statusReason}</> : null}
          {!failed && !terminal && order.estimatedReadyAt ? (
            <>Previsão: por volta das {formatClock(order.estimatedReadyAt, order.timezone)}.</>
          ) : null}
        </Alert>
      </div>

      {gone ? (
        <div className="mt-3">
          <Alert tone="warning">Não encontramos mais este pedido.</Alert>
        </div>
      ) : null}

      {failures > 0 && !terminal ? (
        <div className="mt-3 flex items-start gap-2 rounded-control bg-warning-soft px-4 py-3 text-sm text-warning-soft-fg" role="status">
          <WifiOff aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
          <p>Sem conexão com o restaurante. Vamos tentar de novo em instantes; seu pedido continua registrado.</p>
        </div>
      ) : null}

      <div className="mt-6 grid gap-6 md:grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)]">
        <Card as="section" aria-labelledby="etapas-titulo">
          <h2 id="etapas-titulo" className="mb-4 text-base font-semibold text-fg">
            Andamento
          </h2>
          <OrderTimeline order={order} />
        </Card>
        <Card as="section" aria-labelledby="resumo-pedido-titulo">
          <h2 id="resumo-pedido-titulo" className="mb-4 text-base font-semibold text-fg">
            Resumo do pedido
          </h2>
          <OrderDetails order={order} />
        </Card>
      </div>

      <div className="mt-6 flex flex-col items-stretch gap-3 sm:flex-row sm:items-center sm:justify-between">
        <p className="text-sm text-muted">
          {terminal
            ? "Este pedido foi encerrado."
            : `Atualizado às ${formatClock(checkedAt, order.timezone)}. A página se atualiza sozinha.`}
        </p>
        <div className="flex flex-col gap-2 sm:flex-row">
          {!terminal ? (
            <Button variant="secondary" onClick={manualRefresh} loading={refreshing}>
              <RefreshCw aria-hidden="true" className="size-4" />
              Atualizar agora
            </Button>
          ) : null}
          <Link href={menuHref} className={buttonStyles({ variant: terminal ? "primary" : "secondary" })}>
            Voltar ao cardápio
          </Link>
        </div>
      </div>
      <p className="mt-6 text-xs text-muted">
        Guarde o endereço desta página: o código do pedido na URL é a única forma de acompanhá-lo.
      </p>
    </div>
  );
}
