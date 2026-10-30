import type { OrderStatus, TabStatus, TableStatus } from "./types";

export type Tone = "neutral" | "accent" | "warning" | "danger" | "info";

const TIME_ZONE = "America/Sao_Paulo";

const brl = new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" });
const dateTimeFmt = new Intl.DateTimeFormat("pt-BR", {
  day: "2-digit",
  month: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  timeZone: TIME_ZONE,
});
const fullDateTimeFmt = new Intl.DateTimeFormat("pt-BR", {
  day: "2-digit",
  month: "2-digit",
  year: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  timeZone: TIME_ZONE,
});
const timeFmt = new Intl.DateTimeFormat("pt-BR", {
  hour: "2-digit",
  minute: "2-digit",
  timeZone: TIME_ZONE,
});

export function formatMoney(cents: number): string {
  return brl.format(cents / 100);
}

function safeFormat(fmt: Intl.DateTimeFormat, iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? "--" : fmt.format(date);
}

export const formatDateTime = (iso: string) => safeFormat(dateTimeFmt, iso);
export const formatFullDateTime = (iso: string) => safeFormat(fullDateTimeFmt, iso);
export const formatTime = (iso: string) => safeFormat(timeFmt, iso);

/** "agora", "5 min", "2 h 10 min", "3 d". */
export function formatDuration(fromIso: string, now: number): string {
  const started = new Date(fromIso).getTime();
  if (Number.isNaN(started)) return "";
  const minutes = Math.max(0, Math.floor((now - started) / 60_000));
  if (minutes < 1) return "agora";
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    const rest = minutes % 60;
    return rest ? `${hours} h ${rest} min` : `${hours} h`;
  }
  return `${Math.floor(hours / 24)} d`;
}

/** Código curto e legível da comanda (a comanda não tem número sequencial). */
export function tabShortCode(id: string): string {
  return id.replace(/-/g, "").slice(0, 6).toUpperCase();
}

export const TABLE_STATUS_LABELS: Record<TableStatus, string> = {
  AVAILABLE: "Disponível",
  OCCUPIED: "Ocupada",
  CLEANING: "Em limpeza",
  INACTIVE: "Inativa",
};

export const TABLE_STATUS_TONES: Record<TableStatus, Tone> = {
  AVAILABLE: "accent",
  OCCUPIED: "warning",
  CLEANING: "info",
  INACTIVE: "neutral",
};

export const TAB_STATUS_LABELS: Record<TabStatus, string> = {
  OPEN: "Aberta",
  CLOSED: "Fechada",
  CANCELLED: "Cancelada",
};

export const TAB_STATUS_TONES: Record<TabStatus, Tone> = {
  OPEN: "warning",
  CLOSED: "accent",
  CANCELLED: "danger",
};

export const ORDER_STATUS_LABELS: Record<OrderStatus, string> = {
  RECEIVED: "Novo",
  CONFIRMED: "Confirmado",
  PREPARING: "Em preparo",
  READY: "Pronto",
  OUT_FOR_DELIVERY: "Em entrega",
  COMPLETED: "Concluído",
  CANCELLED: "Cancelado",
  REJECTED: "Recusado",
};

export const ORDER_STATUS_TONES: Record<OrderStatus, Tone> = {
  RECEIVED: "accent",
  CONFIRMED: "info",
  PREPARING: "warning",
  READY: "accent",
  OUT_FOR_DELIVERY: "info",
  COMPLETED: "neutral",
  CANCELLED: "danger",
  REJECTED: "danger",
};

export const PAYMENT_METHOD_LABELS: Record<string, string> = {
  CASH: "Dinheiro",
  PIX: "Pix",
  CREDIT: "Cartão de crédito",
  DEBIT: "Cartão de débito",
  VOUCHER: "Vale-refeição",
  OTHER: "Outro",
};

export const PAYMENT_STATUS_LABELS: Record<string, string> = {
  PENDING: "Pendente",
  PAID: "Pago",
  REFUNDED: "Estornado",
  FAILED: "Falhou",
};

export function paymentMethodLabel(method: string): string {
  return Object.hasOwn(PAYMENT_METHOD_LABELS, method) ? PAYMENT_METHOD_LABELS[method] : "Outro";
}

export function orderStatusLabel(status: string): string {
  return Object.hasOwn(ORDER_STATUS_LABELS, status)
    ? ORDER_STATUS_LABELS[status as OrderStatus]
    : status;
}

export function capacityLabel(capacity: number | null): string {
  if (capacity === null) return "Capacidade não informada";
  return capacity === 1 ? "1 lugar" : `${capacity} lugares`;
}
