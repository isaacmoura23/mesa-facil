import { z } from "zod";

/**
 * Tipos e schemas do painel operacional de pedidos (OPS-A).
 * Toda linha lida do banco passa por zod antes de chegar à UI.
 */

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
export type OrderStatus = (typeof ORDER_STATUSES)[number];

export const ACTIVE_STATUSES = [
  "RECEIVED",
  "CONFIRMED",
  "PREPARING",
  "READY",
  "OUT_FOR_DELIVERY",
] as const satisfies readonly OrderStatus[];

export const CLOSED_STATUSES = [
  "COMPLETED",
  "CANCELLED",
  "REJECTED",
] as const satisfies readonly OrderStatus[];

export function isActiveStatus(status: OrderStatus): boolean {
  return (ACTIVE_STATUSES as readonly string[]).includes(status);
}

export const FULFILLMENT_TYPES = ["DELIVERY", "PICKUP", "DINE_IN"] as const;
export type FulfillmentType = (typeof FULFILLMENT_TYPES)[number];

export const STATUS_LABELS: Record<OrderStatus, string> = {
  RECEIVED: "Novo",
  CONFIRMED: "Confirmado",
  PREPARING: "Em preparo",
  READY: "Pronto",
  OUT_FOR_DELIVERY: "Em entrega",
  COMPLETED: "Concluído",
  CANCELLED: "Cancelado",
  REJECTED: "Recusado",
};

/** Rótulo das abas (plural/coletivo). */
export const TAB_LABELS: Record<OrderStatus, string> = {
  RECEIVED: "Novos",
  CONFIRMED: "Confirmados",
  PREPARING: "Em preparo",
  READY: "Prontos",
  OUT_FOR_DELIVERY: "Em entrega",
  COMPLETED: "Concluídos",
  CANCELLED: "Cancelados",
  REJECTED: "Recusados",
};

export const FULFILLMENT_LABELS: Record<FulfillmentType, string> = {
  DELIVERY: "Entrega",
  PICKUP: "Retirada",
  DINE_IN: "No local",
};

export const PAYMENT_METHOD_LABELS: Record<string, string> = {
  CASH: "Dinheiro",
  PIX: "Pix",
  CARD: "Cartão",
};

export const PAYMENT_STATUS_LABELS: Record<string, string> = {
  UNPAID: "Não pago",
  PENDING: "Pagamento pendente",
  PAID: "Pago",
  REFUNDED: "Estornado",
  FAILED: "Falhou",
};

const statusSchema = z.enum(ORDER_STATUSES);
const fulfillmentSchema = z.enum(FULFILLMENT_TYPES);

const addressSchema = z
  .object({
    street: z.string().nullish(),
    number: z.string().nullish(),
    neighborhood: z.string().nullish(),
    city: z.string().nullish(),
    postal_code: z.string().nullish(),
    complement: z.string().nullish(),
    instructions: z.string().nullish(),
  })
  .passthrough();
export type DeliveryAddress = z.infer<typeof addressSchema>;

const modifierSchema = z.object({
  modifier_name: z.string(),
  group_name: z.string().nullish(),
  quantity: z.number().int(),
  price_delta_cents: z.number().int(),
});
export type OrderItemModifier = z.infer<typeof modifierSchema>;

const itemSchema = z.object({
  id: z.string(),
  product_name: z.string(),
  variant_name_snapshot: z.string().nullish(),
  quantity: z.number().int(),
  unit_price_cents: z.number().int(),
  modifiers_cents: z.number().int(),
  line_total_cents: z.number().int(),
  notes: z.string().nullish(),
  created_at: z.string().nullish(),
  order_item_modifiers: z.array(modifierSchema).default([]),
});
export type OrderItem = z.infer<typeof itemSchema>;

export const orderRowSchema = z.object({
  id: z.string(),
  restaurant_id: z.string(),
  order_number: z.number().int(),
  public_code: z.string(),
  source: z.string(),
  fulfillment_type: fulfillmentSchema,
  status: statusSchema,
  payment_status: z.string(),
  status_reason: z.string().nullish(),
  customer_name: z.string().nullish(),
  customer_phone: z.string().nullish(),
  customer_email: z.string().nullish(),
  delivery_address: addressSchema.nullish(),
  table_label: z.string().nullish(),
  subtotal_cents: z.number().int(),
  delivery_fee_cents: z.number().int(),
  discount_cents: z.number().int(),
  total_cents: z.number().int(),
  notes: z.string().nullish(),
  // Colunas da migração 0114+ (DB-5); opcionais para não quebrar antes dela.
  payment_method_intent: z.string().nullish(),
  change_for_cents: z.number().int().nullish(),
  estimated_ready_at: z.string().nullish(),
  created_at: z.string(),
  updated_at: z.string(),
  order_items: z.array(itemSchema).default([]),
});
export type OperationsOrder = z.infer<typeof orderRowSchema>;

export const transitionRowSchema = z.object({
  fulfillment_type: fulfillmentSchema,
  from_status: statusSchema,
  to_status: statusSchema,
  required_permission: z.string(),
});
export type OrderTransition = z.infer<typeof transitionRowSchema>;

export const historyRowSchema = z.object({
  id: z.union([z.number(), z.string()]),
  from_status: statusSchema.nullable(),
  to_status: statusSchema,
  changed_by: z.string().nullable(),
  reason: z.string().nullable(),
  created_at: z.string(),
});
export type OrderHistoryEntry = z.infer<typeof historyRowSchema> & {
  changedByName: string | null;
};

export type ConnectionState = "connecting" | "online" | "reconnecting" | "offline";

export type PeriodKey = "today" | "24h" | "7d" | "custom";

export type OrderFilters = {
  period: PeriodKey;
  /** yyyy-mm-dd (fuso local do navegador), usado só em `custom`. */
  from: string;
  to: string;
  fulfillment: FulfillmentType | "ALL";
  search: string;
};

export const DEFAULT_FILTERS: OrderFilters = {
  period: "today",
  from: "",
  to: "",
  fulfillment: "ALL",
  search: "",
};

/** Permissões que a tela usa para decidir o que mostrar (a autoridade é o banco). */
export type OperationsPermissions = {
  accept: boolean;
  reject: boolean;
  updateStatus: boolean;
  cancel: boolean;
  print: boolean;
};
