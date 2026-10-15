"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import type { AppSupabaseClient } from "@/lib/supabase/types";
import { dayBoundIso, startOfTodayIso } from "./format";
import {
  CLOSED_PAGE_SIZE,
  fetchActiveOrders,
  fetchClosedOrders,
  fetchOrderById,
  type ClosedQuery,
} from "./queries";
import {
  isActiveStatus,
  type ConnectionState,
  type OperationsOrder,
  type OrderFilters,
} from "./types";

const SAFETY_REFRESH_MS = 60_000;

type FeedOptions = {
  /** Resolvido no servidor pelo guard; nunca derivado do slug no cliente. */
  restaurantId: string;
  filters: OrderFilters;
  /** Pedido RECEIVED que apareceu depois da carga inicial (alerta sonoro). */
  onArrival?: (order: OperationsOrder) => void;
};

export type OrdersFeed = {
  orders: OperationsOrder[];
  loading: boolean;
  error: string | null;
  connection: ConnectionState;
  lastSyncedAt: number | null;
  closedLoaded: boolean;
  closedLoading: boolean;
  closedHasMore: boolean;
  loadClosed: () => void;
  loadMoreClosed: () => void;
  refresh: () => Promise<void>;
  /** Aplica um patch local e devolve a função de rollback (só desfaz se nada mudou). */
  applyOptimistic: (id: string, patch: Partial<OperationsOrder>) => () => void;
  /** Busca o pedido no banco e o incorpora (fonte da verdade). */
  syncOrder: (id: string) => Promise<OperationsOrder | null>;
};

export function resolveClosedQuery(filters: OrderFilters, now = new Date()): ClosedQuery {
  switch (filters.period) {
    case "24h":
      return { since: new Date(now.getTime() - 24 * 3_600_000).toISOString() };
    case "7d":
      return { since: new Date(now.getTime() - 7 * 24 * 3_600_000).toISOString() };
    case "custom": {
      const since = dayBoundIso(filters.from, false);
      if (since) return { since, until: dayBoundIso(filters.to || filters.from, true) };
      return { since: startOfTodayIso(now) };
    }
    default:
      return { since: startOfTodayIso(now) };
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : "Erro inesperado";
}

export function useOrdersFeed({ restaurantId, filters, onArrival }: FeedOptions): OrdersFeed {
  const supabase = useMemo<AppSupabaseClient>(() => createClient(), []);

  const [orders, setOrders] = useState<ReadonlyMap<string, OperationsOrder>>(new Map());
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [connection, setConnection] = useState<ConnectionState>("connecting");
  const [lastSyncedAt, setLastSyncedAt] = useState<number | null>(null);
  const [closedRequested, setClosedRequested] = useState(false);
  const [closedLoading, setClosedLoading] = useState(false);
  const [closedHasMore, setClosedHasMore] = useState(false);

  const ordersRef = useRef<ReadonlyMap<string, OperationsOrder>>(new Map());
  const initialDoneRef = useRef(false);
  const onArrivalRef = useRef(onArrival);
  const filtersRef = useRef(filters);
  const closedRequestedRef = useRef(false);
  const inflightRef = useRef(new Map<string, Promise<OperationsOrder | null>>());

  useEffect(() => {
    onArrivalRef.current = onArrival;
    filtersRef.current = filters;
    closedRequestedRef.current = closedRequested;
  });

  const commit = useCallback(
    (update: (draft: Map<string, OperationsOrder>) => void) => {
      const next = new Map(ordersRef.current);
      update(next);
      ordersRef.current = next;
      setOrders(next);
    },
    [],
  );

  /** Incorpora linhas lidas do banco. Ignora versões mais antigas que a local. */
  const ingest = useCallback(
    (incoming: OperationsOrder[], announce: boolean) => {
      const arrivals: OperationsOrder[] = [];
      commit((draft) => {
        for (const order of incoming) {
          const current = draft.get(order.id);
          if (current && Date.parse(current.updated_at) > Date.parse(order.updated_at)) continue;
          if (!current && announce && order.status === "RECEIVED") arrivals.push(order);
          draft.set(order.id, order);
        }
      });
      for (const order of arrivals) onArrivalRef.current?.(order);
    },
    [commit],
  );

  const syncOrder = useCallback(
    (id: string): Promise<OperationsOrder | null> => {
      const pending = inflightRef.current.get(id);
      if (pending) return pending;
      const job = (async () => {
        try {
          const order = await fetchOrderById(supabase, restaurantId, id);
          if (order) ingest([order], initialDoneRef.current);
          else
            commit((draft) => {
              draft.delete(id);
            });
          return order;
        } catch (cause) {
          console.warn("orders: falha ao sincronizar pedido", messageOf(cause));
          return null;
        } finally {
          inflightRef.current.delete(id);
        }
      })();
      inflightRef.current.set(id, job);
      return job;
    },
    [supabase, restaurantId, ingest, commit],
  );

  const loadClosedFirstPage = useCallback(async () => {
    setClosedLoading(true);
    try {
      const rows = await fetchClosedOrders(supabase, restaurantId, resolveClosedQuery(filtersRef.current));
      commit((draft) => {
        // O período mudou ou há atualização: descarta os fechados locais antes de repor.
        for (const [id, order] of draft) if (!isActiveStatus(order.status)) draft.delete(id);
      });
      ingest(rows, false);
      setClosedHasMore(rows.length >= CLOSED_PAGE_SIZE);
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setClosedLoading(false);
    }
  }, [supabase, restaurantId, commit, ingest]);

  /** Releitura oficial: pedidos ativos (+ fechados, se já pedidos). */
  const refresh = useCallback(async () => {
    try {
      const active = await fetchActiveOrders(supabase, restaurantId);
      const fresh = new Set(active.map((order) => order.id));
      ingest(active, initialDoneRef.current);

      // Ativos locais que sumiram da lista oficial mudaram de estado: relê um a um.
      const stale = [...ordersRef.current.values()].filter(
        (order) => isActiveStatus(order.status) && !fresh.has(order.id),
      );
      await Promise.all(stale.map((order) => syncOrder(order.id)));

      initialDoneRef.current = true;
      setError(null);
      setLastSyncedAt(Date.now());
      if (closedRequestedRef.current) await loadClosedFirstPage();
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setLoading(false);
    }
  }, [supabase, restaurantId, ingest, syncOrder, loadClosedFirstPage]);

  // Carga inicial + releitura de segurança + ao voltar para a aba.
  useEffect(() => {
    // Adiado para a próxima microtask: a carga atualiza estado de forma assíncrona.
    void Promise.resolve().then(refresh);
    const timer = setInterval(() => void refresh(), SAFETY_REFRESH_MS);
    const onVisible = () => {
      if (document.visibilityState === "visible") void refresh();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [refresh]);

  // Realtime: apenas notifica; o pedido é relido do banco a cada evento.
  useEffect(() => {
    let cancelled = false;
    let subscribedBefore = false;
    const channel = supabase.channel(`ops-orders:${restaurantId}`);

    const handleEvent = (payload: {
      eventType: string;
      new: Record<string, unknown>;
      old: Record<string, unknown>;
    }) => {
      const source = payload.eventType === "DELETE" ? payload.old : payload.new;
      const id = typeof source?.id === "string" ? source.id : null;
      if (!id) return;
      if (payload.eventType === "DELETE") {
        commit((draft) => {
          draft.delete(id);
        });
        return;
      }
      void syncOrder(id);
    };

    const start = async () => {
      try {
        await supabase.auth.getSession();
        await supabase.realtime.setAuth();
      } catch {
        // O status do canal abaixo reflete o problema.
      }
      if (cancelled) return;
      channel
        .on(
          "postgres_changes",
          { event: "*", schema: "public", table: "orders", filter: `restaurant_id=eq.${restaurantId}` },
          handleEvent,
        )
        .subscribe((status) => {
          if (cancelled) return;
          if (status === "SUBSCRIBED") {
            setConnection("online");
            // Eventos podem ter sido perdidos enquanto caído: releitura oficial.
            if (subscribedBefore) void refresh();
            subscribedBefore = true;
          } else if (status === "CHANNEL_ERROR" || status === "TIMED_OUT") {
            setConnection("reconnecting");
          } else if (status === "CLOSED") {
            setConnection(navigator.onLine ? "reconnecting" : "offline");
          }
        });
    };
    void start();

    const goOffline = () => setConnection("offline");
    const goOnline = () => {
      setConnection("reconnecting");
      void refresh();
    };
    window.addEventListener("offline", goOffline);
    window.addEventListener("online", goOnline);

    return () => {
      cancelled = true;
      window.removeEventListener("offline", goOffline);
      window.removeEventListener("online", goOnline);
      void supabase.removeChannel(channel);
    };
  }, [supabase, restaurantId, syncOrder, commit, refresh]);

  // Fechados: sob demanda, e de novo quando o período muda.
  const periodKey = `${filters.period}|${filters.from}|${filters.to}`;
  useEffect(() => {
    if (!closedRequested) return;
    void Promise.resolve().then(loadClosedFirstPage);
  }, [closedRequested, periodKey, loadClosedFirstPage]);

  const loadClosed = useCallback(() => setClosedRequested(true), []);

  const loadMoreClosed = useCallback(() => {
    const closed = [...ordersRef.current.values()].filter((order) => !isActiveStatus(order.status));
    const oldest = closed.reduce<string | null>(
      (min, order) => (min === null || order.created_at < min ? order.created_at : min),
      null,
    );
    if (!oldest) return;
    setClosedLoading(true);
    void fetchClosedOrders(supabase, restaurantId, {
      ...resolveClosedQuery(filtersRef.current),
      before: oldest,
    })
      .then((rows) => {
        ingest(rows, false);
        setClosedHasMore(rows.length >= CLOSED_PAGE_SIZE);
      })
      .catch((cause: unknown) => setError(messageOf(cause)))
      .finally(() => setClosedLoading(false));
  }, [supabase, restaurantId, ingest]);

  const applyOptimistic = useCallback(
    (id: string, patch: Partial<OperationsOrder>) => {
      const previous = ordersRef.current.get(id);
      if (!previous) return () => {};
      const optimistic: OperationsOrder = { ...previous, ...patch };
      commit((draft) => {
        draft.set(id, optimistic);
      });
      return () => {
        if (ordersRef.current.get(id) !== optimistic) return;
        commit((draft) => {
          draft.set(id, previous);
        });
      };
    },
    [commit],
  );

  const list = useMemo(() => [...orders.values()], [orders]);

  return {
    orders: list,
    loading,
    error,
    connection,
    lastSyncedAt,
    closedLoaded: closedRequested && !closedLoading,
    closedLoading,
    closedHasMore,
    loadClosed,
    loadMoreClosed,
    refresh,
    applyOptimistic,
    syncOrder,
  };
}
