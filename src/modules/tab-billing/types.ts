import { z } from "zod";

/**
 * Contrato das RPCs da Fase 4 (docs/CONTRACT.md): `get_tab_balance`,
 * `record_payment`, `close_tab`, `cancel_tab`. O banco é a autoridade; aqui só
 * validamos o formato antes de mostrar. Campos extras são tolerados.
 */

export const PAYMENT_METHODS = ["CASH", "PIX", "CREDIT", "DEBIT", "VOUCHER", "OTHER"] as const;
export type PaymentMethod = (typeof PAYMENT_METHODS)[number];

export const PAYMENT_METHOD_LABELS: Record<PaymentMethod, string> = {
  CASH: "Dinheiro",
  PIX: "Pix",
  CREDIT: "Crédito",
  DEBIT: "Débito",
  VOUCHER: "Vale",
  OTHER: "Outro",
};

/** Rótulo tolerante a valores que o contrato não prevê (ex.: CARD de pedidos antigos). */
export function paymentMethodLabel(method: string): string {
  return (PAYMENT_METHOD_LABELS as Record<string, string>)[method] ?? (method === "CARD" ? "Cartão" : method);
}

/** Estados de pedido que não bloqueiam o fechamento da comanda. */
export const TERMINAL_ORDER_STATUSES: readonly string[] = ["COMPLETED", "CANCELLED", "REJECTED"];
/** Estados que não contam no consumo. */
export const VOID_ORDER_STATUSES: readonly string[] = ["CANCELLED", "REJECTED"];

const cents = z.number().int();

const orderSchema = z
  .object({
    id: z.string(),
    order_number: z.number().int().nullish(),
    status: z.string(),
    total_cents: cents.default(0),
  })
  .passthrough();

const paymentSchema = z
  .object({
    id: z.string(),
    method: z.string(),
    amount_cents: cents,
    status: z.string().nullish(),
    tendered_cents: cents.nullish(),
    change_cents: cents.nullish(),
    reference: z.string().nullish(),
    idempotency_key: z.string().nullish(),
    order_id: z.string().nullish(),
    paid_at: z.string().nullish(),
    created_at: z.string().nullish(),
  })
  .passthrough();

const tabSchema = z
  .object({
    id: z.string(),
    status: z.string(),
    label: z.string().nullish(),
    table_label: z.string().nullish(),
    table_name: z.string().nullish(),
    unpaid_cents: cents.nullish(),
    unpaid_reason: z.string().nullish(),
  })
  .passthrough();

export const tabBalanceSchema = z.object({
  tab: tabSchema,
  orders: z.array(orderSchema).default([]),
  consumed_cents: cents,
  paid_cents: cents,
  remaining_cents: cents,
  payments: z.array(paymentSchema).default([]),
});
export type TabBalance = z.infer<typeof tabBalanceSchema>;
export type TabPayment = TabBalance["payments"][number];
export type TabOrder = TabBalance["orders"][number];

export const recordPaymentResultSchema = z
  .object({
    change_cents: cents.nullish(),
    remaining_cents: cents.nullish(),
  })
  .passthrough();
export type RecordPaymentResult = z.infer<typeof recordPaymentResultSchema>;

export const closeTabResultSchema = z.object({}).passthrough();
export const cancelTabResultSchema = z.object({}).passthrough();

export type RecordPaymentInput = {
  tabId: string;
  method: PaymentMethod;
  amountCents: number;
  tenderedCents: number | null;
  /** Chave da tentativa (idempotência) + referência opcional digitada pela equipe. */
  reference: string;
};

export const UNPAID_REASON_MIN = 10;
export const UNPAID_REASON_MAX = 500;
