import { z } from "zod";
import type { AppSupabaseClient } from "@/lib/supabase/types";
import {
  ACTIVE_STATUSES,
  CLOSED_STATUSES,
  historyRowSchema,
  orderRowSchema,
  transitionRowSchema,
  type OperationsOrder,
  type OrderHistoryEntry,
  type OrderTransition,
} from "./types";

/**
 * Leituras do painel (RLS: `orders.view`). `restaurantId` vem do servidor
 * (guard) e é sempre aplicado como filtro, em defesa em profundidade: a RLS
 * continua sendo a autoridade.
 */

/** Pedido + itens + adicionais numa só consulta. `*` tolera colunas novas (DB-5). */
const ORDER_SELECT =
  "*, order_items(id, product_name, variant_name_snapshot, quantity, unit_price_cents, modifiers_cents, line_total_cents, notes, created_at, order_item_modifiers(modifier_name, group_name, quantity, price_delta_cents))";

export const ACTIVE_LIMIT = 300;
export const CLOSED_PAGE_SIZE = 60;

function parseOrders(rows: unknown): OperationsOrder[] {
  if (!Array.isArray(rows)) return [];
  const result: OperationsOrder[] = [];
  for (const row of rows) {
    const parsed = orderRowSchema.safeParse(row);
    if (parsed.success) {
      parsed.data.order_items.sort((a, b) =>
        (a.created_at ?? "").localeCompare(b.created_at ?? ""),
      );
      result.push(parsed.data);
    } else console.warn("orders: linha ignorada por formato inesperado");
  }
  return result;
}

export async function fetchActiveOrders(
  supabase: AppSupabaseClient,
  restaurantId: string,
): Promise<OperationsOrder[]> {
  const { data, error } = await supabase
    .from("orders")
    .select(ORDER_SELECT)
    .eq("restaurant_id", restaurantId)
    .in("status", [...ACTIVE_STATUSES])
    .order("created_at", { ascending: true })
    .limit(ACTIVE_LIMIT);
  if (error) throw new Error(error.message);
  return parseOrders(data);
}

export type ClosedQuery = {
  /** ISO UTC (inclusive). */
  since: string;
  /** ISO UTC (inclusive); sem valor = agora. */
  until?: string | null;
  /** Keyset: só pedidos criados antes deste instante. */
  before?: string | null;
};

export async function fetchClosedOrders(
  supabase: AppSupabaseClient,
  restaurantId: string,
  query: ClosedQuery,
): Promise<OperationsOrder[]> {
  let request = supabase
    .from("orders")
    .select(ORDER_SELECT)
    .eq("restaurant_id", restaurantId)
    .in("status", [...CLOSED_STATUSES])
    .gte("created_at", query.since)
    .order("created_at", { ascending: false })
    .limit(CLOSED_PAGE_SIZE);
  if (query.until) request = request.lte("created_at", query.until);
  if (query.before) request = request.lt("created_at", query.before);
  const { data, error } = await request;
  if (error) throw new Error(error.message);
  return parseOrders(data);
}

export async function fetchOrderById(
  supabase: AppSupabaseClient,
  restaurantId: string,
  orderId: string,
): Promise<OperationsOrder | null> {
  const { data, error } = await supabase
    .from("orders")
    .select(ORDER_SELECT)
    .eq("restaurant_id", restaurantId)
    .eq("id", orderId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!data) return null;
  return parseOrders([data])[0] ?? null;
}

export async function fetchTransitions(
  supabase: AppSupabaseClient,
): Promise<OrderTransition[]> {
  const { data, error } = await supabase
    .from("order_status_transitions")
    .select("fulfillment_type, from_status, to_status, required_permission");
  if (error) throw new Error(error.message);
  return z.array(transitionRowSchema).catch([]).parse(data);
}

const profileSchema = z.object({ id: z.string(), full_name: z.string().nullable() });

export async function fetchOrderHistory(
  supabase: AppSupabaseClient,
  restaurantId: string,
  orderId: string,
): Promise<OrderHistoryEntry[]> {
  const { data, error } = await supabase
    .from("order_status_history")
    .select("id, from_status, to_status, changed_by, reason, created_at")
    .eq("restaurant_id", restaurantId)
    .eq("order_id", orderId)
    .order("created_at", { ascending: true })
    .order("id", { ascending: true });
  if (error) throw new Error(error.message);

  const rows = z.array(historyRowSchema).catch([]).parse(data);
  const userIds = [...new Set(rows.map((row) => row.changed_by).filter((id): id is string => Boolean(id)))];

  const names = new Map<string, string>();
  if (userIds.length > 0) {
    // Colegas ativos do mesmo restaurante são legíveis (RLS de profiles).
    const profiles = await supabase.from("profiles").select("id, full_name").in("id", userIds);
    if (!profiles.error) {
      for (const row of z.array(profileSchema).catch([]).parse(profiles.data)) {
        if (row.full_name) names.set(row.id, row.full_name);
      }
    }
  }

  return rows.map((row) => ({
    ...row,
    changedByName: row.changed_by ? (names.get(row.changed_by) ?? null) : null,
  }));
}
