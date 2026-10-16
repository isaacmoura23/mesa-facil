"use client";

import { useCallback } from "react";
import type { AppSupabaseClient } from "@/lib/supabase/types";
import { fetchSnapshot } from "./queries";
import type { TablesSnapshot } from "./types";
import { useLiveResource, type LiveResource } from "./use-live-resource";

const TABLES = ["restaurant_tables", "tabs", "orders"] as const;

/** Mesas + comandas (abertas e encerradas hoje) em tempo real. */
export function useTablesFeed(restaurantId: string): LiveResource<TablesSnapshot> {
  const load = useCallback(
    (supabase: AppSupabaseClient) => fetchSnapshot(supabase, restaurantId),
    [restaurantId],
  );
  return useLiveResource({
    restaurantId,
    channel: `ops-tables:${restaurantId}`,
    tables: TABLES,
    load,
  });
}
