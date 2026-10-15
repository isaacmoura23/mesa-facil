"use client";

import { useEffect, useMemo, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import type { AppSupabaseClient } from "@/lib/supabase/types";
import { fetchOrderHistory } from "./queries";
import type { OrderHistoryEntry } from "./types";

/**
 * Histórico de status de um pedido (com o nome de quem alterou, quando legível).
 * `version` (ex.: updated_at do pedido) dispara nova leitura quando o pedido muda.
 */
export function useOrderHistory(restaurantId: string, orderId: string, version: string) {
  const supabase = useMemo<AppSupabaseClient>(() => createClient(), []);
  const [entries, setEntries] = useState<OrderHistoryEntry[] | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetchOrderHistory(supabase, restaurantId, orderId)
      .then((rows) => {
        if (cancelled) return;
        setEntries(rows);
        setFailed(false);
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [supabase, restaurantId, orderId, version]);

  return { entries, failed };
}
