import { z } from "zod";
import type { ResolvedPeriod } from "@/lib/period";
import {
  FULFILLMENT_TYPES,
  ORDER_STATUSES,
  type FulfillmentType,
  type OrderStatus,
} from "@/modules/operations/types";
import { firstParam, periodQuery } from "./period-params";

/** Filtros, cursor e formatação do monitoramento de pedidos (puro, sem acesso a dados). */

export const ORDERS_PAGE_SIZE = 25;
export const CSV_MAX_ROWS = 5000;

export type OrderFilters = {
  fulfillment: FulfillmentType | "ALL";
  status: OrderStatus | "ALL";
  /** Somente dígitos (até 9) ou vazio. */
  number: string;
};

export const EMPTY_ORDER_FILTERS: OrderFilters = { fulfillment: "ALL", status: "ALL", number: "" };

type RawParams = Record<string, string | string[] | undefined>;

export function parseOrderFilters(raw: RawParams): OrderFilters {
  const fulfillment = z.enum(FULFILLMENT_TYPES).safeParse(firstParam(raw.fulfillment));
  const status = z.enum(ORDER_STATUSES).safeParse(firstParam(raw.status));
  const digits = (firstParam(raw.number) ?? "").replace(/\D/g, "").replace(/^0+(?=\d)/, "").slice(0, 9);
  return {
    fulfillment: fulfillment.success ? fulfillment.data : "ALL",
    status: status.success ? status.data : "ALL",
    number: digits,
  };
}

export function hasActiveFilters(filters: OrderFilters): boolean {
  return filters.fulfillment !== "ALL" || filters.status !== "ALL" || filters.number !== "";
}

/** Período + filtros -> query string (sem `?`) para links, paginação e exportação. */
export function ordersQuery(
  period: ResolvedPeriod,
  filters: OrderFilters,
  extra: Record<string, string | null> = {},
): string {
  const query = new URLSearchParams(periodQuery(period));
  if (filters.fulfillment !== "ALL") query.set("fulfillment", filters.fulfillment);
  if (filters.status !== "ALL") query.set("status", filters.status);
  if (filters.number) query.set("number", filters.number);
  for (const [key, value] of Object.entries(extra)) {
    if (value) query.set(key, value);
  }
  return query.toString();
}

// Cursor keyset (created_at desc, id desc), opaco para o cliente.
const cursorSchema = z.object({
  t: z.string().regex(/^\d{4}-\d{2}-\d{2}[T ][0-9:.]+(Z|[+-]\d{2}(:?\d{2})?)$/),
  id: z.uuid(),
});
export type OrderCursor = z.infer<typeof cursorSchema>;

export function encodeCursor(cursor: OrderCursor): string {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

export function decodeCursor(raw: string | undefined): OrderCursor | null {
  if (!raw) return null;
  try {
    const parsed = cursorSchema.safeParse(JSON.parse(Buffer.from(raw, "base64url").toString("utf8")));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Formatação no fuso do restaurante

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatter(key: string, timeZone: string, options: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
  const id = `${key}|${timeZone}`;
  let fmt = formatters.get(id);
  if (!fmt) {
    try {
      fmt = new Intl.DateTimeFormat("pt-BR", { ...options, timeZone });
    } catch {
      fmt = new Intl.DateTimeFormat("pt-BR", { ...options, timeZone: "America/Sao_Paulo" });
    }
    formatters.set(id, fmt);
  }
  return fmt;
}

function safe(fmt: Intl.DateTimeFormat, iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? "--" : fmt.format(date);
}

export function formatDateTimeTz(iso: string, timeZone: string): string {
  return safe(
    formatter("dt", timeZone, { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" }),
    iso,
  ).replace(",", "");
}

export function formatTimeTz(iso: string, timeZone: string): string {
  return safe(formatter("t", timeZone, { hour: "2-digit", minute: "2-digit" }), iso);
}

/** Data/hora para o CSV: `dd/mm/aaaa hh:mm:ss` no fuso do restaurante. */
export function formatCsvDateTime(iso: string, timeZone: string): string {
  return safe(
    formatter("csv", timeZone, {
      day: "2-digit",
      month: "2-digit",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    }),
    iso,
  ).replace(",", "");
}

/** Neutraliza fórmulas de planilha (=, +, -, @, tab, CR) e escapa aspas/separadores. */
export function csvCell(value: string): string {
  const safeValue = /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
  return /[";\r\n]/.test(safeValue) ? `"${safeValue.replace(/"/g, '""')}"` : safeValue;
}

export const STATUS_TONES: Record<OrderStatus, "neutral" | "accent" | "warning" | "danger" | "info"> = {
  RECEIVED: "info",
  CONFIRMED: "info",
  PREPARING: "warning",
  READY: "accent",
  OUT_FOR_DELIVERY: "warning",
  COMPLETED: "accent",
  CANCELLED: "danger",
  REJECTED: "danger",
};
