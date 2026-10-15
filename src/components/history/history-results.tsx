"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { History } from "lucide-react";
import { Alert } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { Skeleton } from "@/components/ui/skeleton";
import { FulfillmentBadge, StatusBadge } from "@/components/operations/status-badge";
import { createClient } from "@/lib/supabase/client";
import type { AppSupabaseClient } from "@/lib/supabase/types";
import { formatDateTime, formatMoney } from "@/modules/operations/format";
import { PAYMENT_METHOD_LABELS } from "@/modules/operations/types";
import {
  cursorOf,
  fetchHistoryPage,
  HISTORY_PAGE_SIZE,
  type HistoryFilters,
  type HistoryRow,
} from "./history-model";

type HistoryResultsProps = {
  restaurantId: string;
  filters: HistoryFilters;
  onOpen: (row: HistoryRow) => void;
  /** Informa a lista carregada ao pai (para o resumo). */
  onLoaded?: (count: number, hasMore: boolean) => void;
};

/**
 * Lista paginada (keyset). O pai usa `key` = filtros, então cada filtro novo
 * remonta este componente com estado limpo e uma nova primeira página.
 */
export function HistoryResults({ restaurantId, filters, onOpen, onLoaded }: HistoryResultsProps) {
  const supabase = useMemo<AppSupabaseClient>(() => createClient(), []);
  const [rows, setRows] = useState<HistoryRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [hasMore, setHasMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const rowsRef = useRef<HistoryRow[]>([]);
  const onLoadedRef = useRef(onLoaded);

  useEffect(() => {
    onLoadedRef.current = onLoaded;
  });

  useEffect(() => {
    let cancelled = false;
    fetchHistoryPage(supabase, restaurantId, filters, null)
      .then((page) => {
        if (cancelled) return;
        rowsRef.current = page;
        setRows(page);
        setHasMore(page.length >= HISTORY_PAGE_SIZE);
        setError(null);
        onLoadedRef.current?.(page.length, page.length >= HISTORY_PAGE_SIZE);
      })
      .catch((cause: unknown) => {
        if (!cancelled) setError(cause instanceof Error ? cause.message : "Erro inesperado");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [supabase, restaurantId, filters, attempt]);

  const loadMore = useCallback(async () => {
    const cursor = cursorOf(rowsRef.current);
    if (!cursor || loadingMore) return;
    setLoadingMore(true);
    try {
      const page = await fetchHistoryPage(supabase, restaurantId, filters, cursor);
      const known = new Set(rowsRef.current.map((row) => row.id));
      const next = [...rowsRef.current, ...page.filter((row) => !known.has(row.id))];
      rowsRef.current = next;
      setRows(next);
      setHasMore(page.length >= HISTORY_PAGE_SIZE);
      setError(null);
      onLoadedRef.current?.(next.length, page.length >= HISTORY_PAGE_SIZE);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Erro inesperado");
    } finally {
      setLoadingMore(false);
    }
  }, [supabase, restaurantId, filters, loadingMore]);

  if (loading) {
    return (
      <ul className="flex flex-col gap-2" aria-label="Carregando pedidos">
        {[0, 1, 2, 3].map((key) => (
          <li key={key}>
            <Skeleton className="h-20 w-full rounded-card" />
          </li>
        ))}
      </ul>
    );
  }

  if (error && rows.length === 0) {
    return (
      <Alert tone="danger" title="Não foi possível carregar o histórico">
        <span>{error}. </span>
        <button
          type="button"
          onClick={() => {
            setLoading(true);
            setAttempt((value) => value + 1);
          }}
          className="font-semibold underline underline-offset-4"
        >
          Tentar de novo
        </button>
      </Alert>
    );
  }

  if (rows.length === 0) {
    return (
      <EmptyState
        icon={<History />}
        title="Nenhum pedido com esses filtros"
        description="Amplie o período ou limpe os filtros para ver mais pedidos."
      />
    );
  }

  return (
    <div className="flex flex-col gap-3">
      {error ? (
        <Alert tone="danger" title="Não foi possível carregar mais pedidos">
          {error}
        </Alert>
      ) : null}
      <ul className="flex flex-col gap-2">
        {rows.map((row) => {
          const payment = row.payment_method_intent
            ? (PAYMENT_METHOD_LABELS[row.payment_method_intent] ?? row.payment_method_intent)
            : null;
          return (
            <li key={row.id}>
              <button
                type="button"
                onClick={() => onOpen(row)}
                aria-label={`Abrir detalhes do pedido ${row.order_number}`}
                className="grid w-full grid-cols-[1fr_auto] items-center gap-x-4 gap-y-2 rounded-card border border-line bg-surface p-4 text-left transition-colors hover:bg-surface-2 focus-visible:bg-surface-2 sm:grid-cols-[8rem_1fr_auto]"
              >
                <div className="min-w-0">
                  <p className="text-xl leading-none font-bold tabular-nums text-fg">#{row.order_number}</p>
                  <p className="mt-1.5 text-sm tabular-nums text-muted">{formatDateTime(row.created_at)}</p>
                </div>
                <p className="order-last col-span-2 flex flex-wrap items-center gap-1.5 sm:order-none sm:col-span-1">
                  <StatusBadge status={row.status} />
                  <FulfillmentBadge type={row.fulfillment_type} label={row.table_label} />
                  {payment ? <Badge tone="neutral">{payment}</Badge> : null}
                </p>
                <p className="text-right text-lg font-semibold tabular-nums text-fg">{formatMoney(row.total_cents)}</p>
              </button>
            </li>
          );
        })}
      </ul>
      {hasMore ? (
        <div className="flex justify-center">
          <Button variant="secondary" size="lg" loading={loadingMore} onClick={() => void loadMore()}>
            Carregar mais antigos
          </Button>
        </div>
      ) : (
        <p className="text-center text-sm text-muted">Fim da lista: {rows.length} pedidos.</p>
      )}
    </div>
  );
}
