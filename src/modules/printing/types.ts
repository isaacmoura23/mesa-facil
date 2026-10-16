import { z } from "zod";

/**
 * Contrato das RPCs `request_print` / `mark_print_job` (DB-5, migração 0116).
 * O payload é montado no servidor; aqui só validamos o formato antes de renderizar.
 */

export const PRINT_DOCUMENT_TYPES = ["KITCHEN_TICKET", "ORDER_RECEIPT"] as const;
export type PrintDocumentType = (typeof PRINT_DOCUMENT_TYPES)[number];

export const DOCUMENT_LABELS: Record<PrintDocumentType, string> = {
  KITCHEN_TICKET: "Comanda de preparo",
  ORDER_RECEIPT: "Recibo do pedido",
};

export const PAPER_WIDTHS = ["80", "58"] as const;
export type PaperWidth = (typeof PAPER_WIDTHS)[number];
export const DEFAULT_PAPER_WIDTH: PaperWidth = "80";

const modifierSchema = z.object({
  name: z.string(),
  group_name: z.string().nullish(),
  quantity: z.number().int().default(1),
  price_delta_cents: z.number().int().default(0),
});

export const printItemSchema = z.object({
  name: z.string(),
  variant_name: z.string().nullish(),
  quantity: z.number().int(),
  unit_price_cents: z.number().int().nullish(),
  modifiers_cents: z.number().int().nullish(),
  line_total_cents: z.number().int().nullish(),
  notes: z.string().nullish(),
  modifiers: z.array(modifierSchema).default([]),
});

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

export const printPayloadSchema = z.object({
  document_type: z.enum(PRINT_DOCUMENT_TYPES),
  restaurant_name: z.string(),
  order_number: z.number().int(),
  fulfillment_type: z.enum(["DELIVERY", "PICKUP", "DINE_IN"]),
  created_at: z.string().nullish(),
  created_at_local: z.string().nullish(),
  table_label: z.string().nullish(),
  tab_label: z.string().nullish(),
  notes: z.string().nullish(),
  items: z.array(printItemSchema).default([]),
  // KITCHEN_TICKET
  customer_first_name: z.string().nullish(),
  // ORDER_RECEIPT
  customer_name: z.string().nullish(),
  subtotal_cents: z.number().int().nullish(),
  delivery_fee_cents: z.number().int().nullish(),
  discount_cents: z.number().int().nullish(),
  total_cents: z.number().int().nullish(),
  payment_status: z.string().nullish(),
  payment_method: z.string().nullish(),
  change_for_cents: z.number().int().nullish(),
  delivery_address: addressSchema.nullish(),
});
export type PrintPayload = z.infer<typeof printPayloadSchema>;
export type PrintItem = PrintPayload["items"][number];

export const requestPrintResultSchema = z.object({
  ok: z.literal(true),
  job_id: z.string(),
  status: z.string(),
  payload: printPayloadSchema,
});
export type RequestPrintResult = z.infer<typeof requestPrintResultSchema>;

export type PrintJobStatus = "DISPATCHED" | "FAILED";
