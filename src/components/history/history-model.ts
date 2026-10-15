import { z } from "zod";
import type { AppSupabaseClient } from "@/lib/supabase/types";
import { dayBoundIso, formatDateTime, startOfTodayIso } from "@/modules/operations/format";
import {
  FULFILLMENT_LABELS,
  FULFILLMENT_TYPES,
  ORDER_STATUSES,
  PAYMENT_METHOD_LABELS,
  STATUS_LABELS,
  type FulfillmentType,
  type OrderStatus,
} from "@/modules/operations/types";
import { DOCUMENT_LABELS, type PrintDocumentType } from "@/modules/printing/types";

/** Modelo, leituras (zod) e exportação do histórico de pedidos. Somente leitura, protegido por RLS (orders.view). */

export const HISTORY_PAGE_SIZE = 30;
const EXPORT_PAGE_SIZE = 500;
/** Teto da exportação CSV (pedidos). Acima disso o arquivo é cortado e a tela avisa. */
export const EXPORT_MAX_ROWS = 5000;

export type HistoryPeriod = "today" | "7d" | "30d" | "custom";

export type HistoryFilters = {
  period: HistoryPeriod;
  /** yyyy-mm-dd, usado só em `custom`. */
  from: string;
  to: string;
  fulfillment: FulfillmentType | "ALL";
  status: OrderStatus | "ALL";
  /** Número do pedido (somente dígitos) ou vazio. */
  number: string;
};

export const DEFAULT_HISTORY_FILTERS: HistoryFilters = {
  period: "today",
  from: "",
  to: "",
  fulfillment: "ALL",
  status: "ALL",
  number: "",
};

export const PERIOD_LABELS: Record<HistoryPeriod, string> = {
  today: "Hoje",
  "7d": "Últimos 7 dias",
  "30d": "Últimos 30 dias",
  custom: "Personalizado",
};

export function filtersKey(filters: HistoryFilters): string {
  return JSON.stringify(filters);
}

export function resolveRange(filters: HistoryFilters, now = new Date()): { since: string; until: string | null } {
  switch (filters.period) {
    case "7d":
      return { since: new Date(now.getTime() - 7 * 86_400_000).toISOString(), until: null };
    case "30d":
      return { since: new Date(now.getTime() - 30 * 86_400_000).toISOString(), until: null };
    case "custom": {
      const since = dayBoundIso(filters.from, false);
      if (since) return { since, until: dayBoundIso(filters.to || filters.from, true) };
      return { since: startOfTodayIso(now), until: null };
    }
    default:
      return { since: startOfTodayIso(now), until: null };
  }
}

const listRowSchema = z.object({
  id: z.string(),
  order_number: z.number().int(),
  fulfillment_type: z.enum(FULFILLMENT_TYPES),
  status: z.enum(ORDER_STATUSES),
  payment_status: z.string(),
  payment_method_intent: z.string().nullish(),
  table_label: z.string().nullish(),
  total_cents: z.number().int(),
  created_at: z.string(),
});
export type HistoryRow = z.infer<typeof listRowSchema>;

const LIST_COLUMNS =
  "id, order_number, fulfillment_type, status, payment_status, payment_method_intent, table_label, total_cents, created_at";

function parseRows(data: unknown): HistoryRow[] {
  return z.array(listRowSchema).catch([]).parse(data);
}

export type HistoryCursor = { createdAt: string; id: string };

/** Uma página (keyset por created_at desc, id desc) com os filtros aplicados. */
export async function fetchHistoryPage(
  supabase: AppSupabaseClient,
  restaurantId: string,
  filters: HistoryFilters,
  cursor: HistoryCursor | null,
  pageSize = HISTORY_PAGE_SIZE,
): Promise<HistoryRow[]> {
  const range = resolveRange(filters);
  let request = supabase
    .from("orders")
    .select(LIST_COLUMNS)
    .eq("restaurant_id", restaurantId)
    .gte("created_at", range.since)
    .order("created_at", { ascending: false })
    .order("id", { ascending: false })
    .limit(pageSize);
  if (range.until) request = request.lte("created_at", range.until);
  if (filters.fulfillment !== "ALL") request = request.eq("fulfillment_type", filters.fulfillment);
  if (filters.status !== "ALL") request = request.eq("status", filters.status);
  if (/^\d{1,9}$/.test(filters.number)) request = request.eq("order_number", Number(filters.number));
  if (cursor) {
    // Mesmo instante: desempata pelo id. Os valores vêm do próprio banco (timestamp e uuid).
    request = request.or(
      `created_at.lt.${cursor.createdAt},and(created_at.eq.${cursor.createdAt},id.lt.${cursor.id})`,
    );
  }
  const { data, error } = await request;
  if (error) throw new Error(error.message);
  return parseRows(data);
}

export function cursorOf(rows: HistoryRow[]): HistoryCursor | null {
  const last = rows[rows.length - 1];
  return last ? { createdAt: last.created_at, id: last.id } : null;
}

/** Lê o filtro atual por inteiro (até o teto) para exportação. */
export async function fetchAllForExport(
  supabase: AppSupabaseClient,
  restaurantId: string,
  filters: HistoryFilters,
): Promise<{ rows: HistoryRow[]; truncated: boolean }> {
  const rows: HistoryRow[] = [];
  let cursor: HistoryCursor | null = null;
  while (rows.length < EXPORT_MAX_ROWS) {
    const page = await fetchHistoryPage(supabase, restaurantId, filters, cursor, EXPORT_PAGE_SIZE);
    rows.push(...page);
    if (page.length < EXPORT_PAGE_SIZE) return { rows, truncated: false };
    cursor = cursorOf(page);
  }
  return { rows: rows.slice(0, EXPORT_MAX_ROWS), truncated: true };
}

/** CSV pt-BR (separador ";" e vírgula decimal, com BOM para o Excel). Só campos não sensíveis. */
export function buildCsv(rows: HistoryRow[]): string {
  const header = ["Numero", "Data e hora", "Modalidade", "Estado", "Total (R$)", "Forma de pagamento declarada"];
  const lines = rows.map((row) =>
    [
      String(row.order_number),
      formatDateTime(row.created_at),
      FULFILLMENT_LABELS[row.fulfillment_type],
      STATUS_LABELS[row.status],
      (row.total_cents / 100).toFixed(2).replace(".", ","),
      row.payment_method_intent ? (PAYMENT_METHOD_LABELS[row.payment_method_intent] ?? row.payment_method_intent) : "",
    ]
      .map(csvCell)
      .join(";"),
  );
  return `﻿${[header.map(csvCell).join(";"), ...lines].join("\r\n")}\r\n`;
}

function csvCell(value: string): string {
  // Neutraliza fórmulas de planilha e escapa aspas/separadores.
  const safe = /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
  return /[";\r\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

// ---------------------------------------------------------------------------
// Pedidos de impressão (print_jobs): quem, quando, tipo, estado. RLS: orders.view ou print.request.

const printJobSchema = z.object({
  id: z.string(),
  document_type: z.string(),
  status: z.string(),
  requested_by: z.string().nullable(),
  created_at: z.string(),
  dispatched_at: z.string().nullable(),
  error_message: z.string().nullable(),
});
const profileSchema = z.object({ id: z.string(), full_name: z.string().nullable() });

export type PrintJobEntry = z.infer<typeof printJobSchema> & { requestedByName: string | null };

export const PRINT_STATUS_LABELS: Record<string, string> = {
  REQUESTED: "Solicitado",
  DISPATCHED: "Enviado para impressão (diálogo aberto)",
  PRINTED: "Impresso",
  FAILED: "Falhou",
  CANCELLED: "Cancelado",
};

export function documentLabel(type: string): string {
  return type in DOCUMENT_LABELS ? DOCUMENT_LABELS[type as PrintDocumentType] : type;
}

export async function fetchPrintJobs(
  supabase: AppSupabaseClient,
  restaurantId: string,
  orderId: string,
): Promise<PrintJobEntry[]> {
  const { data, error } = await supabase
    .from("print_jobs")
    .select("id, document_type, status, requested_by, created_at, dispatched_at, error_message")
    .eq("restaurant_id", restaurantId)
    .eq("order_id", orderId)
    .order("created_at", { ascending: false })
    .limit(50);
  if (error) throw new Error(error.message);
  const rows = z.array(printJobSchema).catch([]).parse(data);
  const ids = [...new Set(rows.map((row) => row.requested_by).filter((id): id is string => Boolean(id)))];
  const names = new Map<string, string>();
  if (ids.length > 0) {
    const profiles = await supabase.from("profiles").select("id, full_name").in("id", ids);
    if (!profiles.error) {
      for (const row of z.array(profileSchema).catch([]).parse(profiles.data)) {
        if (row.full_name) names.set(row.id, row.full_name);
      }
    }
  }
  return rows.map((row) => ({
    ...row,
    requestedByName: row.requested_by ? (names.get(row.requested_by) ?? null) : null,
  }));
}
