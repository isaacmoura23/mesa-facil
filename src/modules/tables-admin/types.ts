import { z } from "zod";

/**
 * Tipos do módulo de mesas/comandas do painel de gestão (comandas somente
 * leitura). As linhas do banco são validadas com zod em tempo de execução
 * (o cliente Supabase ainda não tem tipos gerados).
 */

export const TABLE_STATUSES = ["AVAILABLE", "OCCUPIED", "CLEANING", "INACTIVE"] as const;
export const TAB_STATUSES = ["OPEN", "CLOSED", "CANCELLED"] as const;
export const ORDER_STATUSES = [
  "RECEIVED",
  "CONFIRMED",
  "PREPARING",
  "READY",
  "OUT_FOR_DELIVERY",
  "COMPLETED",
  "CANCELLED",
  "REJECTED",
] as const;

export type TableStatus = (typeof TABLE_STATUSES)[number];
export type TabStatus = (typeof TAB_STATUSES)[number];
export type OrderStatus = (typeof ORDER_STATUSES)[number];

export const tableRowSchema = z.object({
  id: z.string(),
  name: z.string(),
  capacity: z.number().nullable(),
  status: z.enum(TABLE_STATUSES),
  sort_order: z.number(),
});
export type TableRow = z.infer<typeof tableRowSchema>;

export const tabRowSchema = z.object({
  id: z.string(),
  table_id: z.string().nullable(),
  label: z.string().nullable(),
  guests: z.number().nullable(),
  status: z.enum(TAB_STATUSES),
  status_reason: z.string().nullable(),
  opened_by: z.string().nullable(),
  opened_at: z.string(),
  closed_by: z.string().nullable(),
  closed_at: z.string().nullable(),
  total_cents: z.number(),
});
export type TabRow = z.infer<typeof tabRowSchema>;

export const orderRowSchema = z.object({
  id: z.string(),
  order_number: z.number(),
  status: z.enum(ORDER_STATUSES),
  source: z.string(),
  total_cents: z.number(),
  created_at: z.string(),
  created_by: z.string().nullable(),
  tab_id: z.string().nullable(),
  notes: z.string().nullable(),
});
export type OrderRow = z.infer<typeof orderRowSchema>;

export const orderTotalRowSchema = z.object({
  tab_id: z.string().nullable(),
  status: z.enum(ORDER_STATUSES),
  total_cents: z.number(),
});

export const orderItemRowSchema = z.object({
  id: z.string(),
  order_id: z.string(),
  product_name: z.string(),
  unit_price_cents: z.number(),
  modifiers_cents: z.number(),
  quantity: z.number(),
  line_total_cents: z.number(),
  notes: z.string().nullable(),
});
export type OrderItemRow = z.infer<typeof orderItemRowSchema>;

export const orderItemModifierRowSchema = z.object({
  order_item_id: z.string(),
  group_name: z.string().nullable(),
  modifier_name: z.string(),
  quantity: z.number(),
});
export type OrderItemModifierRow = z.infer<typeof orderItemModifierRowSchema>;

/** Só colunas não sensíveis (sem referência de provedor, chave ou notas). */
export const paymentRowSchema = z.object({
  id: z.string(),
  order_id: z.string().nullable(),
  tab_id: z.string().nullable(),
  method: z.string(),
  amount_cents: z.number(),
  status: z.string(),
  recorded_by: z.string().nullable(),
  paid_at: z.string().nullable(),
  created_at: z.string(),
});
export type PaymentRow = z.infer<typeof paymentRowSchema>;

export const tabHistoryRowSchema = z.object({
  from_status: z.string().nullable(),
  to_status: z.string(),
  changed_by: z.string().nullable(),
  reason: z.string().nullable(),
  created_at: z.string(),
});
export type TabHistoryRow = z.infer<typeof tabHistoryRowSchema>;

export const orderHistoryRowSchema = z.object({
  order_id: z.string(),
  from_status: z.string().nullable(),
  to_status: z.string(),
  changed_by: z.string().nullable(),
  reason: z.string().nullable(),
  created_at: z.string(),
});
export type OrderHistoryRow = z.infer<typeof orderHistoryRowSchema>;

export const profileRowSchema = z.object({ id: z.string(), full_name: z.string().nullable() });

/** Comanda aberta de uma mesa (somente leitura). */
export type OpenTabInfo = {
  id: string;
  label: string | null;
  guests: number | null;
  openedAt: string;
  /** Consumo parcial (pedidos não cancelados/recusados); `null` se sem permissão. */
  consumedCents: number | null;
  ordersCount: number | null;
};

export type TableWithTab = TableRow & { openTab: OpenTabInfo | null };

export type TablesAdminData = { tables: TableWithTab[] };

export type TableHistoryEntry = {
  id: string;
  status: TabStatus;
  label: string | null;
  openedAt: string;
  closedAt: string | null;
  /** Total fechado; `null` enquanto a comanda estiver aberta. */
  totalCents: number | null;
};

export type TabListItem = {
  id: string;
  shortCode: string;
  status: TabStatus;
  tableName: string | null;
  label: string | null;
  guests: number | null;
  openedAt: string;
  closedAt: string | null;
  /** Fechada: total gravado; aberta: consumo parcial (ou `null` se indisponível). */
  totalCents: number | null;
  partial: boolean;
};

export type TabsPage = { items: TabListItem[]; nextCursor: string | null };

export type TimelineEntry = {
  at: string;
  kind: "tab" | "order" | "payment";
  title: string;
  detail?: string;
  actor?: string | null;
};

export type TabDetailOrder = OrderRow & {
  items: (OrderItemRow & { modifiers: OrderItemModifierRow[] })[];
};

export type TabDetail = {
  tab: TabRow;
  shortCode: string;
  tableName: string | null;
  openedByName: string | null;
  closedByName: string | null;
  /** `null` = o papel do usuário não enxerga pedidos/pagamentos. */
  orders: TabDetailOrder[] | null;
  payments: (PaymentRow & { recordedByName: string | null })[] | null;
  consumedCents: number | null;
  paidCents: number | null;
  timeline: TimelineEntry[];
};

export type Result<T> = { ok: true; data: T } | { ok: false; message: string };

export type ActionResult =
  | { ok: true; message?: string; warning?: string }
  | { ok: false; message: string; fieldErrors?: Record<string, string> };
