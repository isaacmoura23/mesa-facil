import "server-only";
import { cache } from "react";
import { createClient } from "@/lib/supabase/server";
import {
  dashboardSchema,
  detailSchema,
  listPayloadSchema,
  type Cursor,
  type DashboardData,
  type RestaurantDetail,
  type RestaurantPage,
} from "./types";

export type Result<T> = { ok: true; data: T } | { ok: false; message: string };
export type DetailResult = Result<RestaurantDetail> | { ok: false; notFound: true };

export const LIST_PAGE_SIZE = 20;

const UNAVAILABLE = "Esta consulta ainda não está disponível neste ambiente.";
const FAILED = "Não foi possível carregar os dados agora. Atualize a página ou tente novamente em instantes.";

function failure(error: { code?: string } | null): { ok: false; message: string } {
  const code = error?.code;
  return { ok: false, message: code === "PGRST202" || code === "42883" ? UNAVAILABLE : FAILED };
}

/** `true` só para superadmin; suporte (e qualquer falha) cai em somente leitura. */
export const isSuperadmin = cache(async (): Promise<boolean> => {
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("is_platform_superadmin");
  return !error && data === true;
});

export async function getDashboard(): Promise<Result<DashboardData>> {
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("platform_dashboard");
  if (error) return failure(error);
  const parsed = dashboardSchema.safeParse(Array.isArray(data) ? data[0] : data);
  return parsed.success ? { ok: true, data: parsed.data } : { ok: false, message: FAILED };
}

export async function listRestaurants(filters: {
  q: string;
  status: string;
  cursor: Cursor | null;
}): Promise<Result<RestaurantPage>> {
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("platform_list_restaurants", {
    p_search: filters.q || null,
    p_status: filters.status || null,
    p_cursor: filters.cursor,
    p_limit: LIST_PAGE_SIZE,
  });
  if (error) return failure(error);
  const parsed = listPayloadSchema.safeParse(data);
  return parsed.success ? { ok: true, data: parsed.data } : { ok: false, message: FAILED };
}

export async function getRestaurantDetail(id: string): Promise<DetailResult> {
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("platform_get_restaurant", { p_restaurant: id });
  if (error) {
    if (error.message?.toLowerCase().includes("restaurant_not_found") || error.code === "P0002") {
      return { ok: false, notFound: true };
    }
    return failure(error);
  }
  const parsed = detailSchema.safeParse(Array.isArray(data) ? data[0] : data);
  return parsed.success ? { ok: true, data: parsed.data } : { ok: false, message: FAILED };
}
