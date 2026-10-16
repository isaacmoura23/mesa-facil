import { z } from "zod";
import { printItemSchema } from "./types";

/**
 * Contas da comanda (Fase 4): `request_tab_print(p_tab, p_document_type)`.
 * O payload é montado no servidor (sem telefone/e-mail); aqui só validamos o
 * formato antes de renderizar. Campos de total são tolerantes: o documento
 * recalcula o que faltar a partir de itens e pagamentos.
 */

export const BILL_DOCUMENT_TYPES = ["PARTIAL_BILL", "FINAL_BILL"] as const;
export type BillDocumentType = (typeof BILL_DOCUMENT_TYPES)[number];

export const BILL_DOCUMENT_LABELS: Record<BillDocumentType, string> = {
  PARTIAL_BILL: "Conta parcial",
  FINAL_BILL: "Conta final",
};

/** Aviso obrigatório no papel: o sistema não emite nota fiscal. */
export const BILL_NOT_FISCAL_NOTICE: Record<BillDocumentType, string> = {
  PARTIAL_BILL: "CONTA PARCIAL - NÃO É DOCUMENTO FISCAL",
  FINAL_BILL: "CONTA FINAL - NÃO É DOCUMENTO FISCAL",
};

const billPaymentSchema = z.object({
  method: z.string(),
  amount_cents: z.number().int(),
  tendered_cents: z.number().int().nullish(),
  change_cents: z.number().int().nullish(),
  paid_at_local: z.string().nullish(),
});

const billTabSchema = z.object({
  status: z.string().nullish(),
  label: z.string().nullish(),
  table_name: z.string().nullish(),
  guests: z.number().int().nullish(),
  opened_at_local: z.string().nullish(),
  closed_at_local: z.string().nullish(),
});

const billOrderSchema = z.object({
  order_number: z.number().int().nullish(),
  status: z.string().nullish(),
  items: z.array(printItemSchema).default([]),
});

export const billPayloadSchema = z.object({
  document_type: z.enum(BILL_DOCUMENT_TYPES),
  restaurant_name: z.string(),
  /** Dados da comanda (sem cliente). `label` é a identificação digitada pela equipe. */
  tab: billTabSchema.nullish(),
  /** Quando o documento foi pedido (horário local do restaurante). */
  printed_at_local: z.string().nullish(),
  /** Itens consolidados da comanda (pedidos cancelados/recusados ficam de fora). */
  items: z.array(printItemSchema).default([]),
  orders: z.array(billOrderSchema).default([]),
  subtotal_cents: z.number().int().nullish(),
  consumed_cents: z.number().int().nullish(),
  paid_cents: z.number().int().nullish(),
  remaining_cents: z.number().int().nullish(),
  /** Comanda fechada com saldo em aberto (justificado). */
  unpaid_cents: z.number().int().nullish(),
  payments: z.array(billPaymentSchema).default([]),
});
export type BillPayload = z.infer<typeof billPayloadSchema>;

export const requestTabPrintResultSchema = z.object({
  ok: z.literal(true),
  job_id: z.string(),
  status: z.string(),
  payload: billPayloadSchema,
});
export type RequestTabPrintResult = z.infer<typeof requestTabPrintResultSchema>;

export type BillTotals = {
  items: BillPayload["items"];
  subtotalCents: number;
  paidCents: number;
  remainingCents: number;
};

/** "Mesa 4 / Comanda João" a partir do payload. */
export function billPlace(payload: BillPayload): string {
  return [
    payload.tab?.table_name ? `Mesa ${payload.tab.table_name}` : null,
    payload.tab?.label ? `Comanda ${payload.tab.label}` : null,
  ]
    .filter(Boolean)
    .join(" / ");
}

/** Totais do documento: usa o que o servidor mandou e deduz o restante do que foi impresso. */
export function billTotals(payload: BillPayload): BillTotals {
  const items = payload.items.length > 0 ? payload.items : payload.orders.flatMap((order) => order.items);
  const fromItems = items.reduce((sum, item) => sum + (item.line_total_cents ?? 0), 0);
  const subtotalCents = payload.subtotal_cents ?? payload.consumed_cents ?? fromItems;
  const paidCents = payload.paid_cents ?? payload.payments.reduce((sum, payment) => sum + payment.amount_cents, 0);
  const remainingCents = payload.remaining_cents ?? Math.max(0, subtotalCents - paidCents);
  return { items, subtotalCents, paidCents, remainingCents };
}
