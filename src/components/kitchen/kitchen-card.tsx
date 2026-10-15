"use client";

import { memo } from "react";
import { Clock, StickyNote } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils/cn";
import { PrintButton } from "@/components/operations/print-button";
import { FulfillmentBadge } from "@/components/operations/status-badge";
import { elapsedMinutes, formatElapsed, formatTime } from "@/modules/operations/format";
import type { OperationsOrder } from "@/modules/operations/types";
import type { OrderAction } from "@/modules/operations/use-order-actions";

const KITCHEN_DOCUMENTS = ["KITCHEN_TICKET"] as const;

/** Minutos a partir dos quais o cartão é marcado como atrasado, por estado. */
const LATE_AFTER: Partial<Record<OperationsOrder["status"], number>> = {
  RECEIVED: 5,
  CONFIRMED: 10,
  PREPARING: 25,
};

/** Só o primeiro nome: a cozinha não precisa de mais dados pessoais. */
export function firstName(order: OperationsOrder): string | null {
  if (order.fulfillment_type === "DINE_IN") return null;
  const name = order.customer_name?.trim().split(/\s+/)[0];
  return name ? name : null;
}

type KitchenCardProps = {
  order: OperationsOrder;
  now: number;
  /** Ação de avanço permitida a este usuário (ou null = somente leitura). */
  action: OrderAction | null;
  busy: boolean;
  canPrint: boolean;
  /** Mensagem exibida no lugar do botão quando não há ação. */
  idleHint: string | null;
  unseen: boolean;
  onAction: (order: OperationsOrder, action: OrderAction) => void;
};

function KitchenCardView({ order, now, action, busy, canPrint, idleHint, unseen, onAction }: KitchenCardProps) {
  const waited = elapsedMinutes(order.created_at, now);
  const threshold = LATE_AFTER[order.status];
  const late = threshold !== undefined && waited >= threshold;
  const name = firstName(order);
  const awaitingAccept = order.status === "RECEIVED";

  return (
    <li
      aria-busy={busy || undefined}
      className={cn(
        "flex flex-col overflow-hidden rounded-card border-2 bg-surface shadow-card",
        late ? "border-danger" : awaitingAccept ? "border-dashed border-line-strong" : "border-line-strong",
        unseen && "ring-4 ring-accent/50 motion-safe:animate-pulse",
        busy && "opacity-70",
      )}
    >
      <div className="flex items-start justify-between gap-3 p-4 pb-3">
        <div className="min-w-0">
          <p className="text-4xl leading-none font-bold tabular-nums text-fg">#{order.order_number}</p>
          <div className="mt-2 flex flex-wrap items-center gap-1.5">
            <FulfillmentBadge type={order.fulfillment_type} label={order.table_label} />
            {name ? <Badge tone="neutral" className="text-sm">{name}</Badge> : null}
            {awaitingAccept ? <Badge tone="warning" className="text-sm">Aguardando aceite</Badge> : null}
          </div>
        </div>
        <div className="shrink-0 text-right">
          <p className="text-2xl font-semibold tabular-nums text-fg">{formatTime(order.created_at)}</p>
          <p
            className={cn(
              "mt-1 flex items-center justify-end gap-1 text-base tabular-nums",
              late ? "font-bold text-danger" : "text-muted",
            )}
          >
            <Clock aria-hidden="true" className="size-4" />
            {formatElapsed(order.created_at, now)}
            {late ? <span className="sr-only"> (atrasado)</span> : null}
          </p>
        </div>
      </div>

      <ul className="flex flex-col gap-3 border-t border-line px-4 py-3">
        {order.order_items.length === 0 ? <li className="text-base text-muted">Sem itens carregados.</li> : null}
        {order.order_items.map((item) => (
          <li key={item.id} className="grid grid-cols-[3rem_1fr] items-start gap-3">
            <span className="flex h-12 items-center justify-center rounded-control bg-fg text-2xl font-bold tabular-nums text-bg">
              {item.quantity}x
            </span>
            <div className="min-w-0 pt-0.5">
              <p className="text-xl leading-snug font-bold break-words text-fg">{item.product_name}</p>
              {item.variant_name_snapshot ? (
                <p className="mt-0.5 text-lg font-semibold break-words text-accent-soft-fg">
                  {item.variant_name_snapshot}
                </p>
              ) : null}
              {item.order_item_modifiers.length > 0 ? (
                <ul className="mt-1 flex flex-col gap-0.5">
                  {item.order_item_modifiers.map((modifier, index) => (
                    <li key={`${modifier.modifier_name}-${index}`} className="text-lg font-medium break-words text-fg">
                      + {modifier.quantity > 1 ? `${modifier.quantity}x ` : ""}
                      {modifier.modifier_name}
                    </li>
                  ))}
                </ul>
              ) : null}
              {item.notes ? (
                <p className="mt-1.5 flex items-start gap-2 rounded-control bg-warning-soft px-2.5 py-1.5 text-lg font-bold break-words text-warning-soft-fg">
                  <StickyNote aria-hidden="true" className="mt-1 size-4 shrink-0" />
                  <span>
                    <span className="sr-only">Observação do item: </span>
                    {item.notes}
                  </span>
                </p>
              ) : null}
            </div>
          </li>
        ))}
        {order.notes ? (
          <li className="flex items-start gap-2 rounded-control bg-warning-soft px-3 py-2 text-lg font-bold break-words text-warning-soft-fg">
            <StickyNote aria-hidden="true" className="mt-1 size-4 shrink-0" />
            <span>
              <span className="font-semibold">Pedido: </span>
              {order.notes}
            </span>
          </li>
        ) : null}
      </ul>

      <div className="mt-auto flex flex-col gap-2 border-t border-line p-3">
        {action ? (
          <Button size="lg" className="h-14 w-full text-lg" loading={busy} onClick={() => onAction(order, action)}>
            {action.label}
          </Button>
        ) : idleHint ? (
          <p className="px-1 py-2 text-center text-base font-medium text-muted">{idleHint}</p>
        ) : null}
        <PrintButton
          order={order}
          allowed={canPrint}
          size="lg"
          documentTypes={KITCHEN_DOCUMENTS}
          label="Imprimir comanda"
        />
      </div>
    </li>
  );
}

export const KitchenCard = memo(KitchenCardView);
