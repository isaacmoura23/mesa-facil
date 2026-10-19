import { z } from "zod";

export type { ActionResult } from "@/modules/menu/types";

export const FULFILLMENT_TYPES = ["DELIVERY", "PICKUP", "DINE_IN"] as const;
export type FulfillmentType = (typeof FULFILLMENT_TYPES)[number];

export const FULFILLMENT_LABELS: Record<FulfillmentType, { label: string; hint: string }> = {
  DELIVERY: { label: "Entrega", hint: "O cliente recebe em casa, dentro das regiões atendidas." },
  PICKUP: { label: "Retirada", hint: "O cliente busca o pedido no estabelecimento." },
  DINE_IN: { label: "Consumo no local", hint: "Pedidos feitos pelas mesas do salão." },
};

export const settingsRowSchema = z.object({
  accepts_orders: z.boolean(),
  prep_time_minutes: z.number().int(),
  min_order_cents: z.number().int(),
  enabled_fulfillment_types: z.array(z.enum(FULFILLMENT_TYPES)),
  pickup_instructions: z.string().nullable(),
  single_tab_per_table: z.boolean(),
});
export type SettingsRow = z.infer<typeof settingsRowSchema>;

export const hourRowSchema = z.object({
  id: z.string(),
  weekday: z.number().int().min(0).max(6),
  opens_at: z.string(),
  closes_at: z.string(),
});
export type HourRow = z.infer<typeof hourRowSchema>;

export const exceptionRowSchema = z.object({
  id: z.string(),
  on_date: z.string(),
  is_closed: z.boolean(),
  opens_at: z.string().nullable(),
  closes_at: z.string().nullable(),
  description: z.string().nullable(),
});
export type ExceptionRow = z.infer<typeof exceptionRowSchema>;

export const zoneRowSchema = z.object({
  id: z.string(),
  name: z.string(),
  fee_cents: z.number().int(),
  min_order_cents: z.number().int(),
  estimated_minutes: z.number().int().nullable(),
  neighborhoods: z.array(z.string()),
  is_active: z.boolean(),
});
export type ZoneRow = z.infer<typeof zoneRowSchema>;

/** Resumo do que o cliente vê (RPC `public_menu`), só leitura. */
export const publicPreviewSchema = z.object({
  is_open_now: z.boolean(),
  settings: z.object({
    accepts_orders: z.boolean(),
    prep_time_minutes: z.number().nullable(),
    min_order_cents: z.number(),
    enabled_fulfillment_types: z.array(z.string()),
    delivery_zones: z.array(
      z.object({
        id: z.string(),
        name: z.string(),
        fee_cents: z.number(),
        min_order_cents: z.number(),
        estimated_minutes: z.number().nullable(),
      }),
    ),
  }),
});
export type PublicPreview = z.infer<typeof publicPreviewSchema>;

/** Cada bloco é `null` quando a leitura falhou: a seção mostra o erro e bloqueia a edição. */
export type SettingsPageData = {
  settings: SettingsRow | null;
  hours: HourRow[] | null;
  exceptions: ExceptionRow[] | null;
  zones: ZoneRow[] | null;
  preview: PublicPreview | null;
  timezone: string;
  /** Data local de hoje (AAAA-MM-DD) no fuso do restaurante. */
  today: string;
};
