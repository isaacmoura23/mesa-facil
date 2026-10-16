"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import type { AppSupabaseClient } from "@/lib/supabase/types";
import type { ConnectionState } from "@/modules/operations/types";

const SAFETY_REFRESH_MS = 60_000;
const EVENT_DEBOUNCE_MS = 200;

export type LiveResource<T> = {
  data: T | null;
  loading: boolean;
  error: string | null;
  connection: ConnectionState;
  lastSyncedAt: number | null;
  /** Releitura oficial (dedupe: chamadas simultâneas viram uma só). */
  refresh: () => Promise<void>;
};

type Options<T> = {
  /** Resolvido no servidor pelo guard; nunca derivado do slug no cliente. */
  restaurantId: string;
  /** Nome único do canal Realtime. */
  channel: string;
  /** Tabelas observadas (filtradas por restaurant_id). */
  tables: readonly string[];
  /** Deve ser estável (useCallback). */
  load: (supabase: AppSupabaseClient) => Promise<T>;
};

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : "Erro inesperado";
}

/**
 * Carga inicial + releitura a cada 60 s e ao voltar à aba + Realtime
 * (apenas notifica; os dados são relidos do banco, com debounce e dedupe).
 * Ao reconectar o canal, relê tudo, pois eventos podem ter sido perdidos.
 */
export function useLiveResource<T>({
  restaurantId,
  channel: channelName,
  tables,
  load,
}: Options<T>): LiveResource<T> {
  const supabase = useMemo<AppSupabaseClient>(() => createClient(), []);
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [connection, setConnection] = useState<ConnectionState>("connecting");
  const [lastSyncedAt, setLastSyncedAt] = useState<number | null>(null);

  const inflightRef = useRef<Promise<void> | null>(null);
  const queuedRef = useRef(false);
  const aliveRef = useRef(true);
  const loadRef = useRef(load);
  const refreshRef = useRef<() => Promise<void>>(async () => {});
  const tablesKey = tables.join(",");

  useEffect(() => {
    loadRef.current = load;
  });

  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
    };
  }, []);

  const refresh = useCallback((): Promise<void> => {
    if (inflightRef.current) {
      // Já há uma leitura em andamento: agenda UMA releitura depois dela.
      queuedRef.current = true;
      return inflightRef.current;
    }
    const job = (async () => {
      try {
        const next = await loadRef.current(supabase);
        if (!aliveRef.current) return;
        setData(next);
        setError(null);
        setLastSyncedAt(Date.now());
      } catch (cause) {
        if (aliveRef.current) setError(messageOf(cause));
      } finally {
        if (aliveRef.current) setLoading(false);
        inflightRef.current = null;
        if (queuedRef.current && aliveRef.current) {
          queuedRef.current = false;
          void refreshRef.current();
        }
      }
    })();
    inflightRef.current = job;
    return job;
  }, [supabase]);

  useEffect(() => {
    refreshRef.current = refresh;
  }, [refresh]);

  // Carga inicial + releitura de segurança + ao voltar para a aba.
  useEffect(() => {
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

  // Realtime.
  useEffect(() => {
    let cancelled = false;
    let subscribedBefore = false;
    let debounce: ReturnType<typeof setTimeout> | null = null;
    const channel = supabase.channel(channelName);

    const onEvent = () => {
      if (debounce) clearTimeout(debounce);
      debounce = setTimeout(() => void refresh(), EVENT_DEBOUNCE_MS);
    };

    const start = async () => {
      try {
        await supabase.auth.getSession();
        await supabase.realtime.setAuth();
      } catch {
        // O status do canal abaixo reflete o problema.
      }
      if (cancelled) return;
      for (const table of tablesKey.split(",")) {
        channel.on(
          "postgres_changes",
          { event: "*", schema: "public", table, filter: `restaurant_id=eq.${restaurantId}` },
          onEvent,
        );
      }
      channel.subscribe((status) => {
        if (cancelled) return;
        if (status === "SUBSCRIBED") {
          setConnection("online");
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
      if (debounce) clearTimeout(debounce);
      window.removeEventListener("offline", goOffline);
      window.removeEventListener("online", goOnline);
      void supabase.removeChannel(channel);
    };
  }, [supabase, restaurantId, channelName, tablesKey, refresh]);

  return { data, loading, error, connection, lastSyncedAt, refresh };
}
