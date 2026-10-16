"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import type { AppSupabaseClient } from "@/lib/supabase/types";
import { getTabBalance } from "./rpc";
import type { TabBalance } from "./types";

type State =
  | { status: "loading" }
  | { status: "ready"; balance: TabBalance }
  | { status: "error"; message: string; balance: TabBalance | null };

/**
 * Lê `get_tab_balance` e mantém o saldo atualizado: relê após cada ação (via
 * `reload`) e quando pedidos/pagamentos da comanda mudam (Realtime só avisa;
 * o valor sempre vem do banco).
 */
export function useTabBalance(restaurantId: string, tabId: string) {
  const supabase = useMemo<AppSupabaseClient>(() => createClient(), []);
  const [state, setState] = useState<State>({ status: "loading" });
  const seq = useRef(0);

  const reload = useCallback(async (): Promise<TabBalance | null> => {
    const mine = ++seq.current;
    try {
      const balance = await getTabBalance(supabase, tabId);
      if (mine === seq.current) setState({ status: "ready", balance });
      return balance;
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : "Não foi possível ler o saldo da comanda.";
      if (mine === seq.current) {
        setState((previous) => ({
          status: "error",
          message,
          balance: previous.status === "loading" ? null : previous.balance,
        }));
      }
      return null;
    }
  }, [supabase, tabId]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- leitura inicial assíncrona
    void reload();
  }, [reload]);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const channel = supabase.channel(`tab-billing:${restaurantId}:${tabId}`);
    const schedule = () => {
      clearTimeout(timer);
      timer = setTimeout(() => void reload(), 300);
    };
    void (async () => {
      try {
        await supabase.auth.getSession();
        await supabase.realtime.setAuth();
      } catch {
        // Sem Realtime a tela continua correta: relê após cada ação.
      }
      if (cancelled) return;
      for (const table of ["orders", "payments"] as const) {
        channel.on(
          "postgres_changes",
          { event: "*", schema: "public", table, filter: `tab_id=eq.${tabId}` },
          schedule,
        );
      }
      channel.on(
        "postgres_changes",
        { event: "UPDATE", schema: "public", table: "tabs", filter: `id=eq.${tabId}` },
        schedule,
      );
      channel.subscribe();
    })();
    return () => {
      cancelled = true;
      clearTimeout(timer);
      void supabase.removeChannel(channel);
    };
  }, [supabase, restaurantId, tabId, reload]);

  return { supabase, state, reload };
}
