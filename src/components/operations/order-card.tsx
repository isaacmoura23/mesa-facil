"use client";

import { memo } from "react";
import { Clock } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils/cn";
import {
  elapsedMinutes,
  formatElapsed,
  formatMoney,
  formatTime,
  summarizeItems,
} from "@/modules/operations/format";
import { PAYMENT_METHOD_LABELS, type OperationsOrder } from "@/modules/operations/types";
import type { OrderAction } from "@/modules/operations/use-order-actions";
import { FulfillmentBadge, StatusBadge } from "./status-badge";
import { PrintButton } from "./print-button";

type OrderCardProps = {
  order: OperationsOrder;
  now: number;
  /** Chegou depois da carga inicial e ainda não foi visto/aceito. */
  unseen: boolean;
  actions: OrderAction[];
  busy: boolean;
  canPrint: boolean;
  onOpen: (order: OperationsOrder) => void;
  onAction: (order: OperationsOrder, action: OrderAction) => void;
};

function OrderCardView({
  order,
  now,
  unseen,
  actions,
  busy,
  canPrint,
  onOpen,
  onAction,
}: OrderCardProps) {
  const isNew = order.status === "RECEIVED";
  const waited = elapsedMinutes(order.created_at, now);
  const late = isNew && waited >= 10;
  const advance = actions.find((action) => action.kind === "advance");
  const secondary = actions.filter((action) => action !== advance && action.kind !== "cancel");
  const cancel = actions.find((action) => action.kind === "cancel");
  const customer = order.customer_name?.trim() || "Cliente sem nome";
  const payment = order.payment_method_intent
    ? (PAYMENT_METHOD_LABELS[order.payment_method_intent] ?? order.payment_method_intent)
    : null;

  return (
    <li
      className={cn(
        "flex flex-col overflow-hidden rounded-card border bg-surface shadow-card transition-shadow",
        isNew ? "border-accent ring-2 ring-accent/40" : "border-line",
        busy && "opacity-70",
      )}
      aria-busy={busy || undefined}
    >
      {isNew ? (
        <div
          className={cn(
            "flex items-center justify-between bg-accent px-4 py-1.5 text-sm font-semibold text-accent-fg",
            unseen && "motion-safe:animate-pulse",
          )}
        >
          <span>{unseen ? "NOVO PEDIDO" : "Aguardando aceite"}</span>
          {late ? <span>Atrasado</span> : null}
        </div>
      ) : null}

      <button
        type="button"
        onClick={() => onOpen(order)}
        className="flex flex-col gap-3 p-4 text-left hover:bg-surface-2 focus-visible:bg-surface-2"
        aria-label={`Abrir detalhes do pedido ${order.order_number}, ${customer}`}
      >
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="text-2xl font-bold tabular-nums leading-none text-fg">
              #{order.order_number}
            </p>
            <p className="mt-1.5 truncate text-base font-medium text-fg">{customer}</p>
          </div>
          <div className="shrink-0 text-right">
            <p className="text-lg font-semibold tabular-nums text-fg">{formatMoney(order.total_cents)}</p>
            <p
              className={cn(
                "mt-1 flex items-center justify-end gap-1 text-sm tabular-nums",
                late ? "font-semibold text-danger" : "text-muted",
              )}
            >
              <Clock aria-hidden="true" className="size-3.5" />
              {formatTime(order.created_at)} · {formatElapsed(order.created_at, now)}
            </p>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-1.5">
          <FulfillmentBadge type={order.fulfillment_type} label={order.table_label} />
          {!isNew ? <StatusBadge status={order.status} /> : null}
          {payment ? <Badge tone="neutral">{payment}</Badge> : null}
        </div>

        <p className="line-clamp-2 text-sm leading-relaxed text-muted">{summarizeItems(order)}</p>
        {order.status_reason ? (
          <p className="text-sm text-danger-soft-fg">Motivo: {order.status_reason}</p>
        ) : null}
      </button>

      {actions.length > 0 || canPrint ? (
        <div className="mt-auto flex flex-wrap items-center gap-2 border-t border-line p-3">
          {advance ? (
            <Button
              size="lg"
              className="min-w-0 flex-1"
              loading={busy}
              onClick={() => onAction(order, advance)}
            >
              {advance.label}
            </Button>
          ) : null}
          {secondary.map((action) => (
            <Button
              key={action.to}
              size="lg"
              variant="danger"
              disabled={busy}
              onClick={() => onAction(order, action)}
            >
              {action.label}
            </Button>
          ))}
          {!advance && cancel ? (
            <Button size="lg" variant="secondary" disabled={busy} onClick={() => onAction(order, cancel)}>
              Cancelar
            </Button>
          ) : null}
          <PrintButton order={order} allowed={canPrint} size="lg" iconOnly />
        </div>
      ) : null}
    </li>
  );
}

export const OrderCard = memo(OrderCardView);
