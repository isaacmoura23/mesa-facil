import "server-only";
import { cache } from "react";
import { createClient } from "@/lib/supabase/server";
import { parseSubscriptionStatus, type SubscriptionStatus } from "./status";

/**
 * Estado da assinatura do restaurante para banners e tela do dono. Memoizado por requisição.
 * Qualquer falha (RPC ainda não migrada, rede) devolve `null`: sem banner, nunca um aviso falso.
 */
export const getSubscriptionStatus = cache(async (restaurantId: string): Promise<SubscriptionStatus | null> => {
  try {
    const supabase = await createClient();
    const { data, error } = await supabase.rpc("restaurant_subscription_status", { p_restaurant: restaurantId });
    if (error) {
      console.error("[plan] restaurant_subscription_status:", error.code ?? "erro");
      return null;
    }
    return parseSubscriptionStatus(data);
  } catch {
    return null;
  }
});
