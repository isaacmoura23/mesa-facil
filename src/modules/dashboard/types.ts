import { z } from "zod";
import { FULFILLMENT_TYPES } from "@/modules/operations/types";

/**
 * Resposta da RPC `dashboard_metrics` (migração 0124). Tudo que a tela mostra
 * vem daqui; a resposta passa por zod antes de chegar à UI.
 */
const count = z.number().int().nonnegative();
const cents = z.number().int();

export const metricsSchema = z.object({
  period: z.object({ from: z.string(), to: z.string(), timezone: z.string() }),
  orders_count: count,
  gross_orders_count: count,
  gross_sales_cents: cents,
  completed_sales_cents: cents,
  avg_ticket_cents: cents,
  in_progress_orders: count,
  open_tabs: count,
  occupied_tables: count,
  tables_total: count,
  cancelled_count: count,
  rejected_count: count,
  by_fulfillment: z.array(z.object({ type: z.enum(FULFILLMENT_TYPES), orders: count, sales_cents: cents })),
  top_products: z.array(
    z.object({ name: z.string(), variant: z.string().nullish(), quantity: count, sales_cents: cents }),
  ),
  sales_series: z.array(z.object({ day: z.string(), orders: count, sales_cents: cents })),
  payment_methods: z.array(z.object({ method: z.string(), amount_cents: cents, count })),
});
export type DashboardMetrics = z.infer<typeof metricsSchema>;

export type Result<T> = { ok: true; data: T } | { ok: false; message: string };

export const PAYMENT_METHOD_NAMES: Record<string, string> = {
  CASH: "Dinheiro",
  PIX: "Pix",
  CREDIT: "Cartão de crédito",
  DEBIT: "Cartão de débito",
  CARD: "Cartão",
  VOUCHER: "Vale-refeição",
  OTHER: "Outra forma",
};

export function paymentMethodName(method: string): string {
  return Object.hasOwn(PAYMENT_METHOD_NAMES, method) ? PAYMENT_METHOD_NAMES[method] : "Outra forma";
}
