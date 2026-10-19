import "server-only";
import { cache } from "react";
import { z } from "zod";
import type { ResolvedPeriod } from "@/lib/period";
import { createClient } from "@/lib/supabase/server";
import { metricsSchema, type DashboardMetrics, type Result } from "./types";

const LOAD_ERROR = "Não foi possível carregar os indicadores agora. Atualize a página ou tente novamente em instantes.";

const RPC_MESSAGES: Record<string, string> = {
  FORBIDDEN: "Seu papel não tem acesso aos indicadores deste restaurante.",
  RESTAURANT_NOT_FOUND: "Restaurante não encontrado.",
  UNAUTHENTICATED: "Sua sessão expirou. Entre novamente para continuar.",
  INVALID_PERIOD: "O período escolhido é inválido. Use no máximo 366 dias.",
};

/** Fuso do restaurante (a RLS de `restaurants` permite ler o próprio). */
export const getRestaurantTimezone = cache(async (restaurantId: string): Promise<string | null> => {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("restaurants")
    .select("timezone")
    .eq("id", restaurantId)
    .maybeSingle();
  if (error) return null;
  const parsed = z.object({ timezone: z.string().nullable() }).safeParse(data);
  return parsed.success ? parsed.data.timezone : null;
});

/** Erros da RPC vêm como `CODIGO: texto`; só o código é usado para escolher a mensagem. */
function rpcMessage(raw: string): string {
  const code = /^([A-Z_]+):/.exec(raw)?.[1];
  return (code && RPC_MESSAGES[code]) || LOAD_ERROR;
}

export async function getDashboardMetrics(
  restaurantId: string,
  period: ResolvedPeriod,
): Promise<Result<DashboardMetrics>> {
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("dashboard_metrics", {
    p_restaurant: restaurantId,
    p_from: period.fromIso,
    p_to: period.toIso,
  });
  if (error) return { ok: false, message: rpcMessage(error.message) };
  const parsed = metricsSchema.safeParse(data);
  if (!parsed.success) return { ok: false, message: LOAD_ERROR };
  return { ok: true, data: parsed.data };
}
