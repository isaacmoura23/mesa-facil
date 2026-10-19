import "server-only";
import { z } from "zod";
import type { ResolvedPeriod } from "@/lib/period";
import type { AppSupabaseClient } from "@/lib/supabase/types";
import { createClient } from "@/lib/supabase/server";
import { fetchPrintJobs, type PrintJobEntry } from "@/components/history/history-model";
import { fetchOrderById, fetchOrderHistory } from "@/modules/operations/queries";
import {
  FULFILLMENT_TYPES,
  ORDER_STATUSES,
  type OperationsOrder,
  type OrderHistoryEntry,
  type OrderStatus,
} from "@/modules/operations/types";
import {
  CSV_MAX_ROWS,
  ORDERS_PAGE_SIZE,
  encodeCursor,
  type OrderCursor,
  type OrderFilters,
} from "./orders";
import type { Result } from "./types";

const LOAD_ERROR = "Não foi possível carregar os pedidos agora. Atualize a página ou tente novamente em instantes.";
const EXPORT_PAGE_SIZE = 500;

const COLUMNS =
  "id, order_number, fulfillment_type, status, payment_status, payment_method_intent, table_label, customer_name, total_cents, created_at";

const rowSchema = z.object({
  id: z.string(),
  order_number: z.number().int(),
  fulfillment_type: z.enum(FULFILLMENT_TYPES),
  status: z.enum(ORDER_STATUSES),
  payment_status: z.string(),
  payment_method_intent: z.string().nullish(),
  table_label: z.string().nullish(),
  customer_name: z.string().nullish(),
  total_cents: z.number().int(),
  created_at: z.string(),
});
export type OrderListRow = z.infer<typeof rowSchema>;

/** Restaurante (do guard) + período + modalidade + número; o estado é opcional. A RLS continua sendo a autoridade. */
function scoped(supabase: AppSupabaseClient, restaurantId: string, period: ResolvedPeriod, filters: OrderFilters, select: string, head: boolean) {
  let request = supabase
    .from("orders")
    .select(select, head ? { count: "exact", head: true } : undefined)
    .eq("restaurant_id", restaurantId)
    .gte("created_at", period.fromIso)
    .lt("created_at", period.toIso);
  if (filters.fulfillment !== "ALL") request = request.eq("fulfillment_type", filters.fulfillment);
  if (filters.number) request = request.eq("order_number", Number(filters.number));
  return request;
}

async function fetchPage(
  restaurantId: string,
  period: ResolvedPeriod,
  filters: OrderFilters,
  cursor: OrderCursor | null,
  size: number,
): Promise<{ rows: OrderListRow[]; hasMore: boolean }> {
  let request = scoped(await createClient(), restaurantId, period, filters, COLUMNS, false);
  if (filters.status !== "ALL") request = request.eq("status", filters.status);
  if (cursor) {
    // Valores validados por regex/uuid em `decodeCursor`, nunca texto livre.
    request = request.or(`created_at.lt.${cursor.t},and(created_at.eq.${cursor.t},id.lt.${cursor.id})`);
  }
  const { data, error } = await request
    .order("created_at", { ascending: false })
    .order("id", { ascending: false })
    .limit(size + 1);
  if (error) throw new Error(error.message);
  const rows = z.array(rowSchema).catch([]).parse(data);
  return { rows: rows.slice(0, size), hasMore: rows.length > size };
}

export type OrdersPage = { rows: OrderListRow[]; nextCursor: string | null };

export async function listOrders(
  restaurantId: string,
  period: ResolvedPeriod,
  filters: OrderFilters,
  cursor: OrderCursor | null,
): Promise<Result<OrdersPage>> {
  try {
    const page = await fetchPage(restaurantId, period, filters, cursor, ORDERS_PAGE_SIZE);
    const last = page.rows[page.rows.length - 1];
    return {
      ok: true,
      data: {
        rows: page.rows,
        nextCursor: page.hasMore && last ? encodeCursor({ t: last.created_at, id: last.id }) : null,
      },
    };
  } catch {
    return { ok: false, message: LOAD_ERROR };
  }
}

export type StatusCounts = Record<OrderStatus, number>;

/** Pedidos por estado dentro do período e da modalidade escolhidos (o filtro de estado não se aplica). */
export async function getStatusCounts(
  restaurantId: string,
  period: ResolvedPeriod,
  filters: OrderFilters,
): Promise<Result<StatusCounts>> {
  try {
    const supabase = await createClient();
    const entries = await Promise.all(
      ORDER_STATUSES.map(async (status) => {
        const { count, error } = await scoped(supabase, restaurantId, period, filters, "id", true).eq("status", status);
        if (error) throw new Error(error.message);
        return [status, count ?? 0] as const;
      }),
    );
    return { ok: true, data: Object.fromEntries(entries) as StatusCounts };
  } catch {
    return { ok: false, message: LOAD_ERROR };
  }
}

/** Até {@link CSV_MAX_ROWS} pedidos do filtro (mais recentes primeiro). */
export async function listOrdersForCsv(
  restaurantId: string,
  period: ResolvedPeriod,
  filters: OrderFilters,
): Promise<Result<{ rows: OrderListRow[]; truncated: boolean }>> {
  try {
    const rows: OrderListRow[] = [];
    let cursor: OrderCursor | null = null;
    while (rows.length < CSV_MAX_ROWS) {
      const size = Math.min(EXPORT_PAGE_SIZE, CSV_MAX_ROWS - rows.length);
      const page = await fetchPage(restaurantId, period, filters, cursor, size);
      rows.push(...page.rows);
      const last = page.rows[page.rows.length - 1];
      if (!page.hasMore || !last) return { ok: true, data: { rows, truncated: false } };
      cursor = { t: last.created_at, id: last.id };
    }
    return { ok: true, data: { rows, truncated: true } };
  } catch {
    return { ok: false, message: LOAD_ERROR };
  }
}

// ---------------------------------------------------------------------------
// Detalhe

const paymentSchema = z.object({
  id: z.string(),
  method: z.string(),
  status: z.string(),
  amount_cents: z.number().int(),
  paid_at: z.string().nullish(),
  created_at: z.string(),
});
export type OrderPayment = z.infer<typeof paymentSchema>;

export type OrderDetail = {
  order: OperationsOrder;
  history: OrderHistoryEntry[] | null;
  printJobs: PrintJobEntry[] | null;
  payments: OrderPayment[] | null;
};

/** `null` quando o pedido não existe neste restaurante (ou a RLS não o mostra). */
export async function getOrderDetail(restaurantId: string, orderId: string): Promise<Result<OrderDetail | null>> {
  const supabase = await createClient();
  let order: OperationsOrder | null;
  try {
    order = await fetchOrderById(supabase, restaurantId, orderId);
  } catch {
    return { ok: false, message: LOAD_ERROR };
  }
  if (!order) return { ok: true, data: null };

  const [history, printJobs, payments] = await Promise.all([
    fetchOrderHistory(supabase, restaurantId, orderId).catch(() => null),
    fetchPrintJobs(supabase, restaurantId, orderId).catch(() => null),
    (async () => {
      const { data, error } = await supabase
        .from("payments")
        .select("id, method, status, amount_cents, paid_at, created_at")
        .eq("restaurant_id", restaurantId)
        .eq("order_id", orderId)
        .order("created_at", { ascending: true })
        .limit(50);
      return error ? null : z.array(paymentSchema).catch([]).parse(data);
    })().catch(() => null),
  ]);
  return { ok: true, data: { order, history, printJobs, payments } };
}
