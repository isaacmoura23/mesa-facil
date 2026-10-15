import type { DeliveryAddress, OperationsOrder } from "./types";

const TIME_ZONE = "America/Sao_Paulo";

const brl = new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" });
const timeFmt = new Intl.DateTimeFormat("pt-BR", {
  hour: "2-digit",
  minute: "2-digit",
  timeZone: TIME_ZONE,
});
const dateTimeFmt = new Intl.DateTimeFormat("pt-BR", {
  day: "2-digit",
  month: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  timeZone: TIME_ZONE,
});

export function formatMoney(cents: number): string {
  return brl.format(cents / 100);
}

export function formatTime(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? "--:--" : timeFmt.format(date);
}

export function formatDateTime(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? "--" : dateTimeFmt.format(date);
}

/** "agora", "há 5 min", "há 2 h 10 min", "há 3 d". */
export function formatElapsed(iso: string, now: number): string {
  const started = new Date(iso).getTime();
  if (Number.isNaN(started)) return "";
  const minutes = Math.max(0, Math.floor((now - started) / 60_000));
  if (minutes < 1) return "agora";
  if (minutes < 60) return `há ${minutes} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    const rest = minutes % 60;
    return rest ? `há ${hours} h ${rest} min` : `há ${hours} h`;
  }
  return `há ${Math.floor(hours / 24)} d`;
}

export function elapsedMinutes(iso: string, now: number): number {
  const started = new Date(iso).getTime();
  return Number.isNaN(started) ? 0 : Math.max(0, Math.floor((now - started) / 60_000));
}

export function formatPhone(raw: string | null | undefined): string {
  if (!raw) return "";
  const digits = raw.replace(/\D/g, "");
  const local = digits.startsWith("55") && digits.length > 11 ? digits.slice(2) : digits;
  if (local.length === 11) return `(${local.slice(0, 2)}) ${local.slice(2, 7)}-${local.slice(7)}`;
  if (local.length === 10) return `(${local.slice(0, 2)}) ${local.slice(2, 6)}-${local.slice(6)}`;
  return raw;
}

export function formatAddress(address: DeliveryAddress | null | undefined): string[] {
  if (!address) return [];
  const line1 = [address.street, address.number].filter(Boolean).join(", ");
  const line2 = [address.neighborhood, address.city].filter(Boolean).join(" - ");
  return [line1, line2, address.postal_code ? `CEP ${address.postal_code}` : ""].filter(
    (line): line is string => Boolean(line),
  );
}

/** Resumo curto dos itens para o cartão: "2x Pizza, 1x Suco +3". */
export function summarizeItems(order: OperationsOrder, max = 3): string {
  const items = order.order_items;
  if (items.length === 0) return "Sem itens carregados";
  const parts = items.slice(0, max).map((item) => `${item.quantity}x ${item.product_name}`);
  const extra = items.length - max;
  return extra > 0 ? `${parts.join(", ")} +${extra}` : parts.join(", ");
}

export function itemsCount(order: OperationsOrder): number {
  return order.order_items.reduce((sum, item) => sum + item.quantity, 0);
}

/** Início do dia no fuso do restaurante, como ISO UTC. */
export function startOfTodayIso(now = new Date()): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
  // Brasil não tem horário de verão desde 2019: UTC-3 fixo.
  return new Date(`${parts}T00:00:00-03:00`).toISOString();
}

/** yyyy-mm-dd (início/fim do dia, fuso do restaurante) -> ISO UTC. */
export function dayBoundIso(day: string, end: boolean): string | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return null;
  const date = new Date(`${day}T${end ? "23:59:59.999" : "00:00:00"}-03:00`);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}
