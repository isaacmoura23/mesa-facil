import { formatCents } from "@/lib/format";
import type { ReportGroup } from "./catalog";
import type { ReportCell, ReportColumn } from "./schemas";

const MONTHS = ["jan", "fev", "mar", "abr", "mai", "jun", "jul", "ago", "set", "out", "nov", "dez"];

const intFmt = new Intl.NumberFormat("pt-BR", { maximumFractionDigits: 0 });
const compactBrl = new Intl.NumberFormat("pt-BR", {
  style: "currency",
  currency: "BRL",
  notation: "compact",
  maximumFractionDigits: 1,
});

export function formatInt(value: number): string {
  return intFmt.format(value);
}

/** Moeda abreviada para eixos de gráfico (R$ 1,2 mil). */
export function formatCompactCents(cents: number): string {
  return compactBrl.format(cents / 100);
}

const YMD_RE = /^(\d{4})-(\d{2})-(\d{2})/;

/** `YYYY-MM-DD` (data pura, sem fuso) -> `dd/mm/aaaa`. */
export function formatYmd(value: string): string {
  const match = YMD_RE.exec(value);
  return match ? `${match[3]}/${match[2]}/${match[1]}` : value;
}

function addDaysYmd(value: string, days: number): string | null {
  const match = YMD_RE.exec(value);
  if (!match) return null;
  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]) + days));
  return date.toISOString().slice(0, 10);
}

/** Rótulo completo de um bucket de período (tabela). */
export function formatPeriodLabel(value: string, group: ReportGroup): string {
  const match = YMD_RE.exec(value);
  if (!match) return value;
  if (group === "month") return `${MONTHS[Number(match[2]) - 1]}/${match[1]}`;
  if (group === "week") {
    const end = addDaysYmd(value, 6);
    return end ? `${match[3]}/${match[2]} a ${end.slice(8, 10)}/${end.slice(5, 7)}/${end.slice(0, 4)}` : value;
  }
  return formatYmd(value);
}

/** Rótulo curto de um bucket (eixo do gráfico). */
export function formatPeriodShort(value: string, group: ReportGroup): string {
  const match = YMD_RE.exec(value);
  if (!match) return value;
  if (group === "month") return `${MONTHS[Number(match[2]) - 1]}/${match[1].slice(2)}`;
  return `${match[3]}/${match[2]}`;
}

export const FULFILLMENT_LABELS: Record<string, string> = {
  DELIVERY: "Entrega",
  PICKUP: "Retirada",
  DINE_IN: "Consumo no local",
};

export const ORDER_STATUS_LABELS: Record<string, string> = {
  RECEIVED: "Novo",
  CONFIRMED: "Confirmado",
  PREPARING: "Em preparo",
  READY: "Pronto",
  OUT_FOR_DELIVERY: "Em entrega",
  COMPLETED: "Concluído",
  CANCELLED: "Cancelado",
  REJECTED: "Recusado",
};

export const PAYMENT_METHOD_LABELS: Record<string, string> = {
  CASH: "Dinheiro",
  PIX: "Pix",
  CREDIT: "Cartão de crédito",
  DEBIT: "Cartão de débito",
  VOUCHER: "Vale-refeição",
  OTHER: "Outro",
};

function lookup(map: Record<string, string>, value: string): string {
  return Object.hasOwn(map, value) ? map[value] : value;
}

export const fulfillmentLabel = (value: string) => lookup(FULFILLMENT_LABELS, value);
export const orderStatusLabel = (value: string) => lookup(ORDER_STATUS_LABELS, value);
export const paymentMethodLabel = (value: string) => lookup(PAYMENT_METHOD_LABELS, value);

/** Texto legível de uma coluna de texto (traduz códigos do banco). */
export function textLabel(key: string, value: string): string {
  if (key === "type") return fulfillmentLabel(value);
  if (key === "status") return orderStatusLabel(value);
  if (key === "method") return paymentMethodLabel(value);
  return value;
}

/** Formata uma célula para exibição na tabela. */
export function formatCell(column: ReportColumn, value: ReportCell | undefined, group: ReportGroup): string {
  if (value === null || value === undefined || value === "") return "-";
  if (column.type === "cents") return typeof value === "number" ? formatCents(value) : "-";
  if (column.type === "integer") return typeof value === "number" ? formatInt(value) : "-";
  if (column.type === "date") return formatPeriodLabel(String(value), group);
  return textLabel(column.key, String(value));
}

/** Número seguro de uma célula (0 quando ausente ou não numérica). */
export function numberOf(value: ReportCell | undefined): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

// ---------------------------------------------------------------------------
// Datas e horas no fuso do restaurante
// ---------------------------------------------------------------------------

export type DateFormatters = {
  /** dd/mm/aaaa hh:mm */
  dateTime: (iso: string | null | undefined) => string;
  /** dd/mm/aaaa */
  date: (iso: string | null | undefined) => string;
};

export function makeDateFormatters(timezone: string): DateFormatters {
  let dateTimeFmt: Intl.DateTimeFormat;
  let dateFmt: Intl.DateTimeFormat;
  try {
    dateTimeFmt = new Intl.DateTimeFormat("pt-BR", {
      day: "2-digit",
      month: "2-digit",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      timeZone: timezone,
    });
    dateFmt = new Intl.DateTimeFormat("pt-BR", {
      day: "2-digit",
      month: "2-digit",
      year: "numeric",
      timeZone: timezone,
    });
  } catch {
    dateTimeFmt = new Intl.DateTimeFormat("pt-BR", { dateStyle: "short", timeStyle: "short" });
    dateFmt = new Intl.DateTimeFormat("pt-BR", { dateStyle: "short" });
  }
  const safe = (fmt: Intl.DateTimeFormat) => (iso: string | null | undefined) => {
    if (!iso) return "-";
    const date = new Date(iso);
    return Number.isNaN(date.getTime()) ? "-" : fmt.format(date);
  };
  return { dateTime: safe(dateTimeFmt), date: safe(dateFmt) };
}
