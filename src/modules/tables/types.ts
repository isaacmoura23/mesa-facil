import { z } from "zod";
import { orderRowSchema, type OperationsOrder } from "@/modules/operations/types";

/**
 * Tipos e schemas de mesas e comandas (OPS-C1). Toda linha lida do banco
 * passa por zod antes de chegar à UI.
 */

export const TABLE_STATUSES = ["AVAILABLE", "OCCUPIED", "CLEANING", "INACTIVE"] as const;
export type TableStatus = (typeof TABLE_STATUSES)[number];

export const TABLE_STATUS_LABELS: Record<TableStatus, string> = {
  AVAILABLE: "Livre",
  OCCUPIED: "Ocupada",
  CLEANING: "Em limpeza",
  INACTIVE: "Inativa",
};

export const TAB_STATUSES = ["OPEN", "CLOSED", "CANCELLED"] as const;
export type TabStatus = (typeof TAB_STATUSES)[number];

export const TAB_STATUS_LABELS: Record<TabStatus, string> = {
  OPEN: "Aberta",
  CLOSED: "Fechada",
  CANCELLED: "Cancelada",
};

export const tableRowSchema = z.object({
  id: z.string(),
  restaurant_id: z.string(),
  name: z.string(),
  area: z.string().nullish(),
  capacity: z.number().int().nullish(),
  status: z.enum(TABLE_STATUSES),
  sort_order: z.number().int().catch(0),
  updated_at: z.string(),
});
export type RestaurantTable = z.infer<typeof tableRowSchema>;

export const tabRowSchema = z.object({
  id: z.string(),
  restaurant_id: z.string(),
  table_id: z.string().nullish(),
  label: z.string().nullish(),
  guests: z.number().int().nullish(),
  status: z.enum(TAB_STATUSES),
  status_reason: z.string().nullish(),
  opened_at: z.string(),
  closed_at: z.string().nullish(),
  total_cents: z.number().int().catch(0),
  updated_at: z.string(),
});
export type Tab = z.infer<typeof tabRowSchema>;

/** Pedido resumido usado para o total parcial das comandas na grade/lista. */
export const orderBriefSchema = z.object({
  id: z.string(),
  tab_id: z.string().nullable(),
  status: z.string(),
  total_cents: z.number().int(),
});
export type OrderBrief = z.infer<typeof orderBriefSchema>;

/** Pedidos que não contam para o consumo da comanda. */
export function countsTowardTab(status: string): boolean {
  return status !== "CANCELLED" && status !== "REJECTED";
}

export type TabSummary = Tab & {
  /** Consumo parcial (pedidos não cancelados/recusados). */
  consumedCents: number;
  ordersCount: number;
  tableName: string | null;
};

export type TablesSnapshot = {
  tables: RestaurantTable[];
  /** Comandas abertas + fechadas/canceladas hoje. */
  tabs: TabSummary[];
};

const moneyInt = z.number().int();

/** Resposta de `get_tab_balance`. Tolerante: campos extras são ignorados. */
export const tabBalanceSchema = z.object({
  consumed_cents: moneyInt.catch(0),
  paid_cents: moneyInt.catch(0),
  remaining_cents: moneyInt.catch(0),
});
export type TabBalance = z.infer<typeof tabBalanceSchema>;

export { orderRowSchema };
export type TabOrder = OperationsOrder;

/** Permissões que as telas usam para mostrar/ocultar ações (a autoridade é o banco). */
export type TablesPermissions = {
  viewTabs: boolean;
  manageTabs: boolean;
  operateTables: boolean;
  createOrders: boolean;
  viewOrders: boolean;
  recordPayments: boolean;
  print: boolean;
  /** Lista completa de permissões efetivas (para o painel de cobrança). */
  granted: string[];
};

export type StaffCartItemPayload = {
  product_id: string;
  variant_id: string | null;
  quantity: number;
  modifier_ids: string[];
  notes?: string;
};
