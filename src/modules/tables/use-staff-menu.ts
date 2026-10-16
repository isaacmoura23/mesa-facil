"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import type { AppSupabaseClient } from "@/lib/supabase/types";
import { parsePublicMenu, type PublicMenu } from "@/modules/storefront/schemas";

export type StaffMenuState = {
  menu: PublicMenu | null;
  loading: boolean;
  error: string | null;
  reload: () => void;
};

async function fetchMenu(supabase: AppSupabaseClient, slug: string): Promise<PublicMenu> {
  const { data, error } = await supabase.rpc("public_menu", { p_slug: slug });
  if (error) throw new Error(error.message);
  const raw: unknown = Array.isArray(data) ? data[0] : data;
  const menu = raw ? parsePublicMenu(raw) : null;
  if (!menu) throw new Error("Cardápio indisponível.");
  return menu;
}

/**
 * Cardápio completo para o lançamento de pedidos pela equipe. Só carrega
 * quando `enabled` (ao abrir o seletor). Usa a RPC `public_menu`, que já
 * sinaliza itens/tamanhos/adicionais indisponíveis (ficam desabilitados).
 */
export function useStaffMenu(slug: string, enabled: boolean): StaffMenuState {
  const supabase = useMemo<AppSupabaseClient>(() => createClient(), []);
  const [menu, setMenu] = useState<PublicMenu | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const loadedAtRef = useRef(0);

  useEffect(() => {
    if (!enabled) return;
    // Recarrega ao reabrir se o cardápio tem mais de 2 minutos (disponibilidade muda).
    if (menu && attempt === 0 && Date.now() - loadedAtRef.current < 120_000) return;
    let cancelled = false;
    void Promise.resolve().then(async () => {
      if (cancelled) return;
      setLoading(true);
      try {
        const next = await fetchMenu(supabase, slug);
        if (cancelled) return;
        loadedAtRef.current = Date.now();
        setMenu(next);
        setError(null);
      } catch (cause) {
        if (!cancelled) setError(cause instanceof Error ? cause.message : "Erro inesperado");
      } finally {
        if (!cancelled) setLoading(false);
      }
    });
    return () => {
      cancelled = true;
    };
    // `menu` é lido só para decidir o cache; não deve disparar nova carga.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, slug, supabase, attempt]);

  const reload = useCallback(() => setAttempt((value) => value + 1), []);

  return { menu, loading, error, reload };
}
