"use client";

import { useCallback } from "react";
import type { AppSupabaseClient } from "@/lib/supabase/types";
import {
  fetchTabBalance,
  fetchTabById,
  fetchTabOrders,
  fetchTabTableName,
} from "./queries";
import type { Tab, TabBalance, TabOrder } from "./types";
import { useLiveResource, type LiveResource } from "./use-live-resource";

export type TabDetail = {
  /** null = comanda não encontrada (ou sem acesso). */
  tab: Tab | null;
  tableName: string | null;
  orders: TabOrder[];
  balance: TabBalance | null;
};

const TABLES = ["tabs", "orders", "payments"] as const;

export function useTabDetail(restaurantId: string, tabId: string): LiveResource<TabDetail> {
  const load = useCallback(
    async (supabase: AppSupabaseClient): Promise<TabDetail> => {
      const tab = await fetchTabById(supabase, restaurantId, tabId);
      if (!tab) return { tab: null, tableName: null, orders: [], balance: null };
      const [orders, balance, tableName] = await Promise.all([
        fetchTabOrders(supabase, restaurantId, tabId).catch(() => [] as TabOrder[]),
        fetchTabBalance(supabase, tabId),
        tab.table_id ? fetchTabTableName(supabase, restaurantId, tab.table_id) : Promise.resolve(null),
      ]);
      return { tab, tableName, orders, balance };
    },
    [restaurantId, tabId],
  );
  return useLiveResource({
    restaurantId,
    channel: `ops-tab:${tabId}`,
    tables: TABLES,
    load,
  });
}
