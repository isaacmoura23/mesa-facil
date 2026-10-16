import type { AppSupabaseClient } from "@/lib/supabase/types";
import { startOfTodayIso } from "@/modules/operations/format";
import {
  countsTowardTab,
  orderBriefSchema,
  orderRowSchema,
  tabBalanceSchema,
  tabRowSchema,
  tableRowSchema,
  type OrderBrief,
  type RestaurantTable,
  type Tab,
  type TabBalance,
  type TabOrder,
  type TabSummary,
  type TablesSnapshot,
} from "./types";

/**
 * Leituras do módulo (RLS: tables.view / tabs.view / orders.view). O
 * `restaurantId` vem do servidor (guard) e é sempre aplicado como filtro,
 * em defesa em profundidade; a RLS continua sendo a autoridade.
 */

const TABLE_COLUMNS = "id, restaurant_id, name, area, capacity, status, sort_order, updated_at";
const TAB_COLUMNS =
  "id, restaurant_id, table_id, label, guests, status, status_reason, opened_at, closed_at, total_cents, updated_at";
const ORDER_SELECT =
  "*, order_items(id, product_name, variant_name_snapshot, quantity, unit_price_cents, modifiers_cents, line_total_cents, notes, created_at, order_item_modifiers(modifier_name, group_name, quantity, price_delta_cents))";

function parseList<T>(
  rows: unknown,
  parse: (row: unknown) => { success: true; data: T } | { success: false },
  what: string,
): T[] {
  if (!Array.isArray(rows)) return [];
  const result: T[] = [];
  for (const row of rows) {
    const parsed = parse(row);
    if (parsed.success) result.push(parsed.data);
    else console.warn(`${what}: linha ignorada por formato inesperado`);
  }
  return result;
}

export async function fetchTables(
  supabase: AppSupabaseClient,
  restaurantId: string,
): Promise<RestaurantTable[]> {
  const { data, error } = await supabase
    .from("restaurant_tables")
    .select(TABLE_COLUMNS)
    .eq("restaurant_id", restaurantId)
    .order("sort_order", { ascending: true })
    .order("name", { ascending: true })
    .limit(500);
  if (error) throw new Error(error.message);
  return parseList(data, (row) => tableRowSchema.safeParse(row), "tables");
}

/** Comandas abertas + as encerradas (fechadas/canceladas) desde o início do dia. */
export async function fetchTabs(
  supabase: AppSupabaseClient,
  restaurantId: string,
): Promise<Tab[]> {
  const since = startOfTodayIso();
  const { data, error } = await supabase
    .from("tabs")
    .select(TAB_COLUMNS)
    .eq("restaurant_id", restaurantId)
    .or(`status.eq.OPEN,closed_at.gte.${since}`)
    .order("opened_at", { ascending: false })
    .limit(500);
  if (error) throw new Error(error.message);
  return parseList(data, (row) => tabRowSchema.safeParse(row), "tabs");
}

export async function fetchTabById(
  supabase: AppSupabaseClient,
  restaurantId: string,
  tabId: string,
): Promise<Tab | null> {
  const { data, error } = await supabase
    .from("tabs")
    .select(TAB_COLUMNS)
    .eq("restaurant_id", restaurantId)
    .eq("id", tabId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!data) return null;
  const parsed = tabRowSchema.safeParse(data);
  return parsed.success ? parsed.data : null;
}

async function fetchOrderBriefs(
  supabase: AppSupabaseClient,
  restaurantId: string,
  tabIds: string[],
): Promise<OrderBrief[]> {
  if (tabIds.length === 0) return [];
  const { data, error } = await supabase
    .from("orders")
    .select("id, tab_id, status, total_cents")
    .eq("restaurant_id", restaurantId)
    .in("tab_id", tabIds)
    .limit(5000);
  // Sem orders.view o total parcial fica indisponível, mas a grade continua útil.
  if (error) return [];
  return parseList(data, (row) => orderBriefSchema.safeParse(row), "orders");
}

export async function fetchSnapshot(
  supabase: AppSupabaseClient,
  restaurantId: string,
): Promise<TablesSnapshot> {
  const [tables, tabs] = await Promise.all([
    fetchTables(supabase, restaurantId),
    fetchTabs(supabase, restaurantId),
  ]);
  const briefs = await fetchOrderBriefs(
    supabase,
    restaurantId,
    tabs.map((tab) => tab.id),
  );
  const names = new Map(tables.map((table) => [table.id, table.name]));
  const consumed = new Map<string, { cents: number; count: number }>();
  for (const order of briefs) {
    if (!order.tab_id || !countsTowardTab(order.status)) continue;
    const entry = consumed.get(order.tab_id) ?? { cents: 0, count: 0 };
    entry.cents += order.total_cents;
    entry.count += 1;
    consumed.set(order.tab_id, entry);
  }
  const summaries: TabSummary[] = tabs.map((tab) => ({
    ...tab,
    consumedCents: consumed.get(tab.id)?.cents ?? 0,
    ordersCount: consumed.get(tab.id)?.count ?? 0,
    tableName: tab.table_id ? (names.get(tab.table_id) ?? null) : null,
  }));
  return { tables, tabs: summaries };
}

export async function fetchTabOrders(
  supabase: AppSupabaseClient,
  restaurantId: string,
  tabId: string,
): Promise<TabOrder[]> {
  const { data, error } = await supabase
    .from("orders")
    .select(ORDER_SELECT)
    .eq("restaurant_id", restaurantId)
    .eq("tab_id", tabId)
    .order("created_at", { ascending: true })
    .limit(300);
  if (error) throw new Error(error.message);
  const orders = parseList(data, (row) => orderRowSchema.safeParse(row), "tab-orders");
  for (const order of orders) {
    order.order_items.sort((a, b) => (a.created_at ?? "").localeCompare(b.created_at ?? ""));
  }
  return orders;
}

export async function fetchTabTableName(
  supabase: AppSupabaseClient,
  restaurantId: string,
  tableId: string,
): Promise<string | null> {
  const { data } = await supabase
    .from("restaurant_tables")
    .select("name")
    .eq("restaurant_id", restaurantId)
    .eq("id", tableId)
    .maybeSingle();
  const name = (data as { name?: unknown } | null)?.name;
  return typeof name === "string" ? name : null;
}

/** `get_tab_balance` (tabs.view). Devolve null se a RPC ainda não existir/falhar. */
export async function fetchTabBalance(
  supabase: AppSupabaseClient,
  tabId: string,
): Promise<TabBalance | null> {
  const { data, error } = await supabase.rpc("get_tab_balance", { p_tab: tabId });
  if (error) return null;
  const raw: unknown = Array.isArray(data) ? data[0] : data;
  const parsed = tabBalanceSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}
