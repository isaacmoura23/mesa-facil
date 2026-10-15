import type { OrderStatus } from "@/modules/orders-server/tracking";
import type { Fulfillment } from "./schemas";

/** Textos PT-BR do acompanhamento, específicos de cada modalidade. */

export const TERMINAL_STATUSES: ReadonlySet<OrderStatus> = new Set([
  "COMPLETED",
  "CANCELLED",
  "REJECTED",
]);

export type TimelineStep = { status: OrderStatus; label: string };

/** Etapas do caminho feliz (a recusa/cancelamento aparecem à parte). */
export function timelineSteps(fulfillment: Fulfillment): TimelineStep[] {
  const ready: Record<Fulfillment, string> = {
    DELIVERY: "Pronto",
    PICKUP: "Pronto para retirada",
    DINE_IN: "Pronto",
  };
  const done: Record<Fulfillment, string> = {
    DELIVERY: "Entregue",
    PICKUP: "Retirado",
    DINE_IN: "Concluído",
  };
  const steps: TimelineStep[] = [
    { status: "RECEIVED", label: "Pedido recebido" },
    { status: "CONFIRMED", label: "Confirmado" },
    { status: "PREPARING", label: "Em preparo" },
    { status: "READY", label: ready[fulfillment] },
  ];
  if (fulfillment === "DELIVERY") {
    steps.push({ status: "OUT_FOR_DELIVERY", label: "Saiu para entrega" });
  }
  steps.push({ status: "COMPLETED", label: done[fulfillment] });
  return steps;
}

export function statusHeadline(status: OrderStatus, fulfillment: Fulfillment): string {
  switch (status) {
    case "RECEIVED":
      return "Pedido enviado. Aguardando a confirmação do restaurante.";
    case "CONFIRMED":
      return "O restaurante confirmou seu pedido.";
    case "PREPARING":
      return "Seu pedido está sendo preparado.";
    case "READY":
      return fulfillment === "PICKUP"
        ? "Seu pedido está pronto. Pode retirar!"
        : fulfillment === "DELIVERY"
          ? "Seu pedido está pronto e aguarda o entregador."
          : "Seu pedido está pronto.";
    case "OUT_FOR_DELIVERY":
      return "Seu pedido saiu para entrega.";
    case "COMPLETED":
      return fulfillment === "DELIVERY"
        ? "Pedido entregue. Bom apetite!"
        : fulfillment === "PICKUP"
          ? "Pedido retirado. Bom apetite!"
          : "Pedido concluído. Bom apetite!";
    case "REJECTED":
      return "O restaurante não pôde aceitar o seu pedido.";
    case "CANCELLED":
      return "Este pedido foi cancelado.";
  }
}

export const PAYMENT_STATUS_LABELS: Record<string, string> = {
  UNPAID: "A pagar",
  PAID: "Pago",
  REFUNDED: "Reembolsado",
  PARTIALLY_PAID: "Pago em parte",
};

export function formatClock(iso: string, timezone: string | null): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  try {
    return new Intl.DateTimeFormat("pt-BR", {
      hour: "2-digit",
      minute: "2-digit",
      timeZone: timezone ?? undefined,
    }).format(date);
  } catch {
    return new Intl.DateTimeFormat("pt-BR", { hour: "2-digit", minute: "2-digit" }).format(date);
  }
}

export function formatDateTime(iso: string, timezone: string | null): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  const options: Intl.DateTimeFormatOptions = {
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  };
  try {
    return new Intl.DateTimeFormat("pt-BR", { ...options, timeZone: timezone ?? undefined }).format(date);
  } catch {
    return new Intl.DateTimeFormat("pt-BR", options).format(date);
  }
}
