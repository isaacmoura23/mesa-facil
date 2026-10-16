import "server-only";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import type { AppSupabaseClient } from "@/lib/supabase/types";
import { orderStatusLabel, formatMoney, paymentMethodLabel, tabShortCode } from "./format";
import {
  CSV_MAX_ROWS,
  TAB_PAGE_SIZE,
  type TabFilters,
} from "./schemas";
import { encodeCursor, type TabCursor } from "./cursor";
import {
  orderHistoryRowSchema,
  orderItemModifierRowSchema,
  orderItemRowSchema,
  orderRowSchema,
  orderTotalRowSchema,
  paymentRowSchema,
  profileRowSchema,
  tabHistoryRowSchema,
  tabRowSchema,
  tableRowSchema,
  type OrderHistoryRow,
  type OrderRow,
  type PaymentRow,
  type Result,
  type TabDetail,
  type TabDetailOrder,
  type TabListItem,
  type TableHistoryEntry,
  type TableRow,
  type TableWithTab,
  type TablesAdminData,
  type TabsPage,
  type TimelineEntry,
} from "./types";

const LOAD_ERROR =
  "Não foi possível carregar os dados agora. Atualize a página ou tente novamente em instantes.";
const ROW_LIMIT = 1000;
const IN_CHUNK = 100;

/** O que o papel do usuário pode enxergar além da própria lista. */
export type ViewPermissions = {
  /** `orders.view`: pedidos e itens. */
  orders: boolean;
  /** `reports.view` ou `payments.record`: pagamentos. */
  payments: boolean;
};

const TAB_COLUMNS =
  "id, table_id, label, guests, status, status_reason, opened_by, opened_at, closed_by, closed_at, total_cents";

const collator = new Intl.Collator("pt-BR", { numeric: true, sensitivity: "base" });

/** Ordem de exibição: `sort_order`, depois nome em ordem natural (Mesa 2 < Mesa 10). */
export function sortTables<T extends { sort_order: number; name: string }>(rows: T[]): T[] {
  return [...rows].sort((a, b) => a.sort_order - b.sort_order || collator.compare(a.name, b.name));
}

function chunk<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/** Primeiro dia seguinte a `YYYY-MM-DD` (calendário puro, sem fuso). */
function nextDay(date: string): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

/** São Paulo não tem horário de verão desde 2019: offset fixo -03:00. */
const SP_OFFSET = "-03:00";

// ---------------------------------------------------------------------------
// Blocos reutilizáveis
// ---------------------------------------------------------------------------

type Consumed = Map<string, { cents: number; count: number }>;

/** Consumo parcial por comanda (pedidos ativos e concluídos; ignora cancelados/recusados). */
async function consumedByTab(
  supabase: AppSupabaseClient,
  restaurantId: string,
  tabIds: string[],
): Promise<Consumed> {
  const out: Consumed = new Map();
  for (const ids of chunk(tabIds, IN_CHUNK)) {
    const { data, error } = await supabase
      .from("orders")
      .select("tab_id, status, total_cents")
      .eq("restaurant_id", restaurantId)
      .in("tab_id", ids)
      .limit(ROW_LIMIT);
    if (error) continue;
    for (const row of z.array(orderTotalRowSchema).catch([]).parse(data)) {
      if (!row.tab_id || row.status === "CANCELLED" || row.status === "REJECTED") continue;
      const current = out.get(row.tab_id) ?? { cents: 0, count: 0 };
      out.set(row.tab_id, { cents: current.cents + row.total_cents, count: current.count + 1 });
    }
  }
  return out;
}

async function profileNames(
  supabase: AppSupabaseClient,
  userIds: (string | null | undefined)[],
): Promise<Map<string, string>> {
  const ids = [...new Set(userIds.filter((id): id is string => Boolean(id)))];
  const names = new Map<string, string>();
  for (const part of chunk(ids, IN_CHUNK)) {
    // Colegas do mesmo restaurante são legíveis (RLS de profiles); só o nome.
    const { data, error } = await supabase.from("profiles").select("id, full_name").in("id", part);
    if (error) continue;
    for (const row of z.array(profileRowSchema).catch([]).parse(data)) {
      if (row.full_name) names.set(row.id, row.full_name);
    }
  }
  return names;
}

/** Formas de pagamento (PAID) por comanda: pagamentos da comanda e dos pedidos dela. */
async function paymentMethodsByTab(
  supabase: AppSupabaseClient,
  restaurantId: string,
  tabIds: string[],
): Promise<Map<string, string[]>> {
  const out = new Map<string, Set<string>>();
  const add = (tabId: string, method: string) => {
    const set = out.get(tabId) ?? new Set<string>();
    set.add(paymentMethodLabel(method));
    out.set(tabId, set);
  };
  const rowSchema = z.object({ tab_id: z.string().nullable(), order_id: z.string().nullable(), method: z.string() });

  for (const ids of chunk(tabIds, IN_CHUNK)) {
    const direct = await supabase
      .from("payments")
      .select("tab_id, order_id, method")
      .eq("restaurant_id", restaurantId)
      .eq("status", "PAID")
      .in("tab_id", ids)
      .limit(ROW_LIMIT);
    if (!direct.error) {
      for (const row of z.array(rowSchema).catch([]).parse(direct.data)) {
        if (row.tab_id) add(row.tab_id, row.method);
      }
    }

    const orders = await supabase
      .from("orders")
      .select("id, tab_id")
      .eq("restaurant_id", restaurantId)
      .in("tab_id", ids)
      .limit(ROW_LIMIT * 2);
    if (orders.error) continue;
    const orderToTab = new Map<string, string>();
    for (const row of z.array(z.object({ id: z.string(), tab_id: z.string().nullable() })).catch([]).parse(orders.data)) {
      if (row.tab_id) orderToTab.set(row.id, row.tab_id);
    }
    for (const orderIds of chunk([...orderToTab.keys()], IN_CHUNK)) {
      const viaOrder = await supabase
        .from("payments")
        .select("tab_id, order_id, method")
        .eq("restaurant_id", restaurantId)
        .eq("status", "PAID")
        .in("order_id", orderIds)
        .limit(ROW_LIMIT);
      if (viaOrder.error) continue;
      for (const row of z.array(rowSchema).catch([]).parse(viaOrder.data)) {
        const tabId = row.order_id ? orderToTab.get(row.order_id) : undefined;
        if (tabId) add(tabId, row.method);
      }
    }
  }
  return new Map([...out].map(([key, set]) => [key, [...set]]));
}

// ---------------------------------------------------------------------------
// Mesas
// ---------------------------------------------------------------------------

/**
 * Mesas do restaurante com a comanda aberta de cada uma (somente leitura).
 * A RLS decide o que o usuário enxerga; sem `tabs.view` as comandas não vêm.
 */
export async function getTablesAdminData(
  restaurantId: string,
  perms: { tabs: boolean; orders: boolean },
): Promise<Result<TablesAdminData>> {
  const supabase = await createClient();

  const tablesRes = await supabase
    .from("restaurant_tables")
    .select("id, name, capacity, status, sort_order")
    .eq("restaurant_id", restaurantId)
    .limit(ROW_LIMIT);
  if (tablesRes.error) return { ok: false, message: LOAD_ERROR };
  const tables = sortTables(z.array(tableRowSchema).catch([]).parse(tablesRes.data));

  const openByTable = new Map<string, TableWithTab["openTab"]>();
  if (perms.tabs) {
    const tabsRes = await supabase
      .from("tabs")
      .select(TAB_COLUMNS)
      .eq("restaurant_id", restaurantId)
      .eq("status", "OPEN")
      .not("table_id", "is", null)
      .order("opened_at", { ascending: false })
      .limit(ROW_LIMIT);
    if (tabsRes.error) return { ok: false, message: LOAD_ERROR };
    const openTabs = z.array(tabRowSchema).catch([]).parse(tabsRes.data);
    const consumed = perms.orders
      ? await consumedByTab(supabase, restaurantId, openTabs.map((tab) => tab.id))
      : null;
    for (const tab of openTabs) {
      if (!tab.table_id || openByTable.has(tab.table_id)) continue;
      const sums = consumed?.get(tab.id);
      openByTable.set(tab.table_id, {
        id: tab.id,
        label: tab.label,
        guests: tab.guests,
        openedAt: tab.opened_at,
        consumedCents: consumed ? (sums?.cents ?? 0) : null,
        ordersCount: consumed ? (sums?.count ?? 0) : null,
      });
    }
  }

  return {
    ok: true,
    data: { tables: tables.map((table) => ({ ...table, openTab: openByTable.get(table.id) ?? null })) },
  };
}

/** Mesas para o filtro de comandas (id e nome). */
export async function getTableOptions(restaurantId: string): Promise<TableRow[]> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("restaurant_tables")
    .select("id, name, capacity, status, sort_order")
    .eq("restaurant_id", restaurantId)
    .limit(ROW_LIMIT);
  if (error) return [];
  return sortTables(z.array(tableRowSchema).catch([]).parse(data));
}

/** Últimas comandas de uma mesa (somente leitura). */
export async function getTableHistory(
  restaurantId: string,
  tableId: string,
  limit = 10,
): Promise<Result<TableHistoryEntry[]>> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("tabs")
    .select(TAB_COLUMNS)
    .eq("restaurant_id", restaurantId)
    .eq("table_id", tableId)
    .order("opened_at", { ascending: false })
    .order("id", { ascending: false })
    .limit(limit);
  if (error) return { ok: false, message: LOAD_ERROR };
  const rows = z.array(tabRowSchema).catch([]).parse(data);
  return {
    ok: true,
    data: rows.map((tab) => ({
      id: tab.id,
      status: tab.status,
      label: tab.label,
      openedAt: tab.opened_at,
      closedAt: tab.closed_at,
      totalCents: tab.status === "OPEN" ? null : tab.total_cents,
    })),
  };
}

// ---------------------------------------------------------------------------
// Comandas
// ---------------------------------------------------------------------------

async function fetchTabs(
  supabase: AppSupabaseClient,
  restaurantId: string,
  filters: TabFilters,
  cursor: TabCursor | null,
  limit: number,
) {
  let query = supabase
    .from("tabs")
    .select(TAB_COLUMNS)
    .eq("restaurant_id", restaurantId)
    .order("opened_at", { ascending: false })
    .order("id", { ascending: false })
    .limit(limit);
  if (filters.status !== "ALL") query = query.eq("status", filters.status);
  if (filters.from) query = query.gte("opened_at", `${filters.from}T00:00:00${SP_OFFSET}`);
  if (filters.to) query = query.lt("opened_at", `${nextDay(filters.to)}T00:00:00${SP_OFFSET}`);
  if (filters.table === "none") query = query.is("table_id", null);
  else if (filters.table) query = query.eq("table_id", filters.table);
  if (cursor) {
    query = query.or(`opened_at.lt.${cursor.t},and(opened_at.eq.${cursor.t},id.lt.${cursor.id})`);
  }
  return query;
}

function toListItem(
  tab: z.infer<typeof tabRowSchema>,
  tableNames: Map<string, string>,
  consumed: Consumed | null,
): TabListItem {
  const open = tab.status === "OPEN";
  return {
    id: tab.id,
    shortCode: tabShortCode(tab.id),
    status: tab.status,
    tableName: tab.table_id ? (tableNames.get(tab.table_id) ?? null) : null,
    label: tab.label,
    guests: tab.guests,
    openedAt: tab.opened_at,
    closedAt: tab.closed_at,
    totalCents: open ? (consumed ? (consumed.get(tab.id)?.cents ?? 0) : null) : tab.total_cents,
    partial: open,
  };
}

/** Página de comandas (keyset por `opened_at desc, id desc`). */
export async function listTabs(
  restaurantId: string,
  filters: TabFilters,
  cursor: TabCursor | null,
  tables: TableRow[],
  perms: ViewPermissions,
): Promise<Result<TabsPage>> {
  const supabase = await createClient();
  const { data, error } = await fetchTabs(supabase, restaurantId, filters, cursor, TAB_PAGE_SIZE + 1);
  if (error) return { ok: false, message: LOAD_ERROR };

  const rows = z.array(tabRowSchema).catch([]).parse(data);
  const page = rows.slice(0, TAB_PAGE_SIZE);
  const last = page[page.length - 1];
  const nextCursor =
    rows.length > TAB_PAGE_SIZE && last ? encodeCursor({ t: last.opened_at, id: last.id }) : null;

  const openIds = page.filter((tab) => tab.status === "OPEN").map((tab) => tab.id);
  const consumed = perms.orders && openIds.length > 0 ? await consumedByTab(supabase, restaurantId, openIds) : null;
  const names = new Map(tables.map((table) => [table.id, table.name]));

  return {
    ok: true,
    data: {
      items: page.map((tab) => toListItem(tab, names, perms.orders ? (consumed ?? new Map()) : null)),
      nextCursor,
    },
  };
}

export type CsvRow = {
  code: string;
  place: string;
  status: string;
  openedAt: string;
  closedAt: string;
  total: string;
  methods: string;
};

/** Linhas para exportação (até `CSV_MAX_ROWS`), com as mesmas regras do filtro. */
export async function getTabsForCsv(
  restaurantId: string,
  filters: TabFilters,
  tables: TableRow[],
  perms: ViewPermissions,
): Promise<Result<{ rows: CsvRow[]; truncated: boolean }>> {
  const supabase = await createClient();
  const tabs: z.infer<typeof tabRowSchema>[] = [];
  let cursor: TabCursor | null = null;
  const batch = 500;
  let truncated = false;

  while (tabs.length < CSV_MAX_ROWS) {
    const { data, error } = await fetchTabs(supabase, restaurantId, filters, cursor, batch + 1);
    if (error) return { ok: false, message: LOAD_ERROR };
    const rows = z.array(tabRowSchema).catch([]).parse(data);
    const page = rows.slice(0, batch);
    tabs.push(...page);
    const last: z.infer<typeof tabRowSchema> | undefined = page[page.length - 1];
    if (rows.length <= batch || !last) break;
    cursor = { t: last.opened_at, id: last.id };
    if (tabs.length >= CSV_MAX_ROWS) truncated = true;
  }
  const limited = tabs.slice(0, CSV_MAX_ROWS);

  const openIds = limited.filter((tab) => tab.status === "OPEN").map((tab) => tab.id);
  const consumed = perms.orders && openIds.length > 0 ? await consumedByTab(supabase, restaurantId, openIds) : new Map();
  const methods = perms.payments
    ? await paymentMethodsByTab(supabase, restaurantId, limited.map((tab) => tab.id))
    : new Map<string, string[]>();
  const tableNames = new Map(tables.map((table) => [table.id, table.name]));

  return {
    ok: true,
    data: {
      truncated,
      rows: limited.map((tab) => {
        const tableName = tab.table_id ? tableNames.get(tab.table_id) : undefined;
        const place = tableName
          ? tab.label
            ? `${tableName} (${tab.label})`
            : tableName
          : `Balcão${tab.label ? ` (${tab.label})` : ""}`;
        const cents = tab.status === "OPEN" ? (consumed.get(tab.id)?.cents ?? 0) : tab.total_cents;
        return {
          code: tabShortCode(tab.id),
          place,
          status: tab.status,
          openedAt: tab.opened_at,
          closedAt: tab.closed_at ?? "",
          total: (cents / 100).toFixed(2).replace(".", ","),
          methods: (methods.get(tab.id) ?? []).join(" + "),
        };
      }),
    },
  };
}

// ---------------------------------------------------------------------------
// Detalhe da comanda
// ---------------------------------------------------------------------------

export async function getTabDetail(
  restaurantId: string,
  tabId: string,
  perms: ViewPermissions,
): Promise<Result<TabDetail> | { ok: "notfound" }> {
  const supabase = await createClient();

  const tabRes = await supabase
    .from("tabs")
    .select(TAB_COLUMNS)
    .eq("restaurant_id", restaurantId)
    .eq("id", tabId)
    .maybeSingle();
  if (tabRes.error) return { ok: false, message: LOAD_ERROR };
  const parsedTab = tabRowSchema.safeParse(tabRes.data);
  if (!tabRes.data || !parsedTab.success) return { ok: "notfound" };
  const tab = parsedTab.data;

  const [tableRes, historyRes] = await Promise.all([
    tab.table_id
      ? supabase.from("restaurant_tables").select("name").eq("restaurant_id", restaurantId).eq("id", tab.table_id).maybeSingle()
      : Promise.resolve({ data: null, error: null }),
    supabase
      .from("tab_status_history")
      .select("from_status, to_status, changed_by, reason, created_at")
      .eq("restaurant_id", restaurantId)
      .eq("tab_id", tabId)
      .order("created_at")
      .limit(100),
  ]);
  const tableName = z.object({ name: z.string() }).safeParse(tableRes.data);
  const tabHistory = z.array(tabHistoryRowSchema).catch([]).parse(historyRes.data);

  // Pedidos, itens e histórico de pedidos.
  let orders: TabDetailOrder[] | null = null;
  let orderHistory: OrderHistoryRow[] = [];
  let orderRows: OrderRow[] = [];
  if (perms.orders) {
    const ordersRes = await supabase
      .from("orders")
      .select("id, order_number, status, source, total_cents, created_at, created_by, tab_id, notes")
      .eq("restaurant_id", restaurantId)
      .eq("tab_id", tabId)
      .order("created_at")
      .limit(ROW_LIMIT);
    if (ordersRes.error) return { ok: false, message: LOAD_ERROR };
    orderRows = z.array(orderRowSchema).catch([]).parse(ordersRes.data);
    const orderIds = orderRows.map((order) => order.id);

    const items: z.infer<typeof orderItemRowSchema>[] = [];
    const modifiers: z.infer<typeof orderItemModifierRowSchema>[] = [];
    for (const ids of chunk(orderIds, IN_CHUNK)) {
      const [itemsRes, historyOrdersRes] = await Promise.all([
        supabase
          .from("order_items")
          .select("id, order_id, product_name, unit_price_cents, modifiers_cents, quantity, line_total_cents, notes")
          .eq("restaurant_id", restaurantId)
          .in("order_id", ids)
          .order("created_at")
          .limit(ROW_LIMIT * 2),
        supabase
          .from("order_status_history")
          .select("order_id, from_status, to_status, changed_by, reason, created_at")
          .eq("restaurant_id", restaurantId)
          .in("order_id", ids)
          .order("created_at")
          .limit(ROW_LIMIT * 2),
      ]);
      if (!itemsRes.error) items.push(...z.array(orderItemRowSchema).catch([]).parse(itemsRes.data));
      if (!historyOrdersRes.error) {
        orderHistory = orderHistory.concat(z.array(orderHistoryRowSchema).catch([]).parse(historyOrdersRes.data));
      }
    }
    for (const ids of chunk(items.map((item) => item.id), IN_CHUNK)) {
      const modsRes = await supabase
        .from("order_item_modifiers")
        .select("order_item_id, group_name, modifier_name, quantity")
        .eq("restaurant_id", restaurantId)
        .in("order_item_id", ids)
        .limit(ROW_LIMIT * 5);
      if (!modsRes.error) modifiers.push(...z.array(orderItemModifierRowSchema).catch([]).parse(modsRes.data));
    }

    orders = orderRows.map((order) => ({
      ...order,
      items: items
        .filter((item) => item.order_id === order.id)
        .map((item) => ({ ...item, modifiers: modifiers.filter((mod) => mod.order_item_id === item.id) })),
    }));
  }

  // Pagamentos (somente colunas não sensíveis).
  let payments: PaymentRow[] | null = null;
  if (perms.payments) {
    const columns = "id, order_id, tab_id, method, amount_cents, status, recorded_by, paid_at, created_at";
    const collected = new Map<string, PaymentRow>();
    const direct = await supabase
      .from("payments")
      .select(columns)
      .eq("restaurant_id", restaurantId)
      .eq("tab_id", tabId)
      .limit(ROW_LIMIT);
    if (direct.error) return { ok: false, message: LOAD_ERROR };
    for (const row of z.array(paymentRowSchema).catch([]).parse(direct.data)) collected.set(row.id, row);
    for (const ids of chunk(orderRows.map((order) => order.id), IN_CHUNK)) {
      const viaOrders = await supabase
        .from("payments")
        .select(columns)
        .eq("restaurant_id", restaurantId)
        .in("order_id", ids)
        .limit(ROW_LIMIT);
      if (viaOrders.error) continue;
      for (const row of z.array(paymentRowSchema).catch([]).parse(viaOrders.data)) collected.set(row.id, row);
    }
    payments = [...collected.values()].sort((a, b) => Date.parse(a.paid_at ?? a.created_at) - Date.parse(b.paid_at ?? b.created_at));
  }

  const names = await profileNames(supabase, [
    tab.opened_by,
    tab.closed_by,
    ...tabHistory.map((row) => row.changed_by),
    ...orderRows.map((order) => order.created_by),
    ...orderHistory.map((row) => row.changed_by),
    ...(payments ?? []).map((payment) => payment.recorded_by),
  ]);
  const nameOf = (id: string | null): string | null => (id ? (names.get(id) ?? null) : null);

  const consumedCents = orders
    ? orders
        .filter((order) => order.status !== "CANCELLED" && order.status !== "REJECTED")
        .reduce((sum, order) => sum + order.total_cents, 0)
    : null;
  const paidCents = payments
    ? payments.filter((payment) => payment.status === "PAID").reduce((sum, payment) => sum + payment.amount_cents, 0)
    : null;

  // Linha do tempo.
  const timeline: TimelineEntry[] = [];
  if (tabHistory.length === 0) {
    timeline.push({ at: tab.opened_at, kind: "tab", title: "Comanda aberta", actor: nameOf(tab.opened_by) });
  }
  for (const row of tabHistory) {
    const title =
      row.to_status === "OPEN" && row.from_status === null
        ? "Comanda aberta"
        : row.to_status === "CLOSED"
          ? "Comanda fechada"
          : row.to_status === "CANCELLED"
            ? "Comanda cancelada"
            : `Comanda: ${row.to_status}`;
    timeline.push({ at: row.created_at, kind: "tab", title, detail: row.reason ?? undefined, actor: nameOf(row.changed_by) });
  }
  for (const order of orderRows) {
    timeline.push({
      at: order.created_at,
      kind: "order",
      title: `Pedido #${order.order_number} lançado`,
      detail: formatMoney(order.total_cents),
      actor: nameOf(order.created_by),
    });
  }
  const numberOf = new Map(orderRows.map((order) => [order.id, order.order_number]));
  for (const row of orderHistory) {
    if (row.from_status === null) continue;
    timeline.push({
      at: row.created_at,
      kind: "order",
      title: `Pedido #${numberOf.get(row.order_id) ?? "?"}: ${orderStatusLabel(row.to_status)}`,
      detail: row.reason ?? undefined,
      actor: nameOf(row.changed_by),
    });
  }
  for (const payment of payments ?? []) {
    if (payment.status !== "PAID") continue;
    timeline.push({
      at: payment.paid_at ?? payment.created_at,
      kind: "payment",
      title: `Pagamento registrado: ${paymentMethodLabel(payment.method)}`,
      detail: formatMoney(payment.amount_cents),
      actor: nameOf(payment.recorded_by),
    });
  }
  timeline.sort((a, b) => Date.parse(a.at) - Date.parse(b.at));

  return {
    ok: true,
    data: {
      tab,
      shortCode: tabShortCode(tab.id),
      tableName: tableName.success ? tableName.data.name : null,
      openedByName: nameOf(tab.opened_by),
      closedByName: nameOf(tab.closed_by),
      orders,
      payments: payments?.map((payment) => ({ ...payment, recordedByName: nameOf(payment.recorded_by) })) ?? null,
      consumedCents,
      paidCents,
      timeline,
    },
  };
}
