import { z } from "zod";
import { FULFILLMENTS, type Fulfillment } from "@/modules/storefront/schemas";
import { PAYMENT_METHODS, type PaymentMethod } from "./schemas";

/**
 * Modelo de acompanhamento (camelCase) montado a partir do JSON de `track_order`.
 * Sem PII: nada de telefone, e-mail, nome do cliente ou endereço completo.
 * Módulo puro (sem server-only): os tipos são usados pelo componente cliente.
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

export type TrackedItem = {
  name: string;
  variantName: string | null;
  quantity: number;
  unitPriceCents: number;
  lineTotalCents: number;
  modifiers: { name: string; priceDeltaCents: number }[];
  notes: string | null;
};

export type TrackedOrder = {
  restaurantName: string;
  /** Fuso do restaurante (IANA), para exibir horários. */
  timezone: string | null;
  orderNumber: number;
  fulfillmentType: Fulfillment;
  status: OrderStatus;
  paymentStatus: string;
  paymentMethod: PaymentMethod | null;
  items: TrackedItem[];
  subtotalCents: number;
  deliveryFeeCents: number;
  discountCents: number;
  totalCents: number;
  statusHistory: { status: OrderStatus; at: string }[];
  /** Apenas o bairro (nunca o endereço completo). */
  neighborhood: string | null;
  createdAt: string | null;
  estimatedReadyAt: string | null;
  /** Motivo informado pelo restaurante em recusa/cancelamento. */
  statusReason: string | null;
};

const cents = z.number().int().min(0).max(1_000_000_000).catch(0);
const optText = (max: number) =>
  z
    .string()
    .max(max)
    .nullish()
    .transform((v) => {
      const t = v?.trim();
      return t ? t : null;
    })
    .catch(null);

const statusSchema = z.enum(ORDER_STATUSES);

const itemSchema = z.object({
  name: z.string().max(300).catch(""),
  variant_name: optText(200),
  quantity: z.number().int().min(0).max(1000).catch(0),
  unit_price_cents: cents,
  line_total_cents: cents,
  modifiers: z
    .array(
      z.object({
        name: z.string().max(300).catch(""),
        price_delta_cents: z.number().int().catch(0),
      }),
    )
    .catch([]),
  notes: optText(500),
});

const rootSchema = z.object({
  restaurant: z
    .object({ name: z.string().max(200), timezone: z.string().max(64).nullish().catch(null) })
    .optional(),
  order_number: z.coerce.number().int().min(0),
  fulfillment_type: z.enum(FULFILLMENTS),
  status: statusSchema,
  payment_status: z.string().max(40).catch("UNPAID"),
  payment_method: z.enum(PAYMENT_METHODS).nullish().catch(null),
  items: z.array(z.unknown()).catch([]),
  subtotal_cents: cents,
  delivery_fee_cents: cents,
  discount_cents: cents,
  total_cents: cents,
  status_history: z.array(z.unknown()).catch([]),
  neighborhood: optText(120),
  created_at: optText(40),
  estimated_ready_at: optText(40),
  status_message: optText(500),
});

const historySchema = z.object({ to_status: statusSchema, at: z.string().max(40) });

/** Converte o JSON de `track_order`; `null` se o formato for inesperado. */
export function parseTrackedOrder(raw: unknown): TrackedOrder | null {
  const parsed = rootSchema.safeParse(raw);
  if (!parsed.success) return null;
  const d = parsed.data;
  const restaurantName = d.restaurant?.name ?? "";
  const items: TrackedItem[] = [];
  for (const item of d.items) {
    const p = itemSchema.safeParse(item);
    if (!p.success) continue;
    items.push({
      name: p.data.name,
      variantName: p.data.variant_name,
      quantity: p.data.quantity,
      unitPriceCents: p.data.unit_price_cents,
      lineTotalCents: p.data.line_total_cents,
      modifiers: p.data.modifiers.map((m) => ({ name: m.name, priceDeltaCents: m.price_delta_cents })),
      notes: p.data.notes,
    });
  }
  const statusHistory: TrackedOrder["statusHistory"] = [];
  for (const entry of d.status_history) {
    const p = historySchema.safeParse(entry);
    if (p.success) statusHistory.push({ status: p.data.to_status, at: p.data.at });
  }
  return {
    restaurantName,
    timezone: d.restaurant?.timezone ?? null,
    orderNumber: d.order_number,
    fulfillmentType: d.fulfillment_type,
    status: d.status,
    paymentStatus: d.payment_status,
    paymentMethod: d.payment_method ?? null,
    items,
    subtotalCents: d.subtotal_cents,
    deliveryFeeCents: d.delivery_fee_cents,
    discountCents: d.discount_cents,
    totalCents: d.total_cents,
    statusHistory,
    neighborhood: d.neighborhood,
    createdAt: d.created_at,
    estimatedReadyAt: d.estimated_ready_at,
    statusReason: d.status_message,
  };
}

export type TrackResult =
  | { status: "ok"; order: TrackedOrder }
  | { status: "not_found" }
  | { status: "error" };
