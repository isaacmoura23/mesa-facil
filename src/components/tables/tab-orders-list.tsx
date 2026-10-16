import { ChefHat } from "lucide-react";
import { EmptyState } from "@/components/ui/empty-state";
import { StatusBadge } from "@/components/operations/status-badge";
import { cn } from "@/lib/utils/cn";
import { formatMoney, formatTime } from "@/modules/operations/format";
import type { TabOrder } from "@/modules/tables/types";

/** Pedidos da comanda com itens, adicionais, observações e estado de cada pedido. */
export function TabOrdersList({ orders }: { orders: TabOrder[] }) {
  if (orders.length === 0) {
    return (
      <EmptyState
        icon={<ChefHat />}
        title="Nenhum pedido nesta comanda"
        description="Use Adicionar itens para lançar o primeiro pedido. A cozinha o recebe na hora."
      />
    );
  }
  return (
    <ul className="space-y-3">
      {orders.map((order) => {
        const dropped = order.status === "CANCELLED" || order.status === "REJECTED";
        return (
          <li
            key={order.id}
            className={cn("rounded-card border border-line bg-surface p-4 shadow-card", dropped && "opacity-70")}
          >
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="flex flex-wrap items-center gap-2">
                <h3 className="text-base font-semibold tabular-nums text-fg">Pedido #{order.order_number}</h3>
                <StatusBadge status={order.status} />
                <span className="text-xs text-muted">{formatTime(order.created_at)}</span>
              </div>
              <p className={cn("text-base font-semibold tabular-nums", dropped ? "text-muted line-through" : "text-fg")}>
                {formatMoney(order.total_cents)}
              </p>
            </div>

            {order.status_reason && dropped ? (
              <p className="mt-1 text-sm text-danger">Motivo: {order.status_reason}</p>
            ) : null}

            {order.order_items.length > 0 ? (
              <ul className="mt-3 space-y-2 border-t border-line pt-3">
                {order.order_items.map((item) => (
                  <li key={item.id} className="flex items-start justify-between gap-3 text-sm">
                    <div className="min-w-0">
                      <p className="text-fg">
                        <span className="font-semibold tabular-nums">{item.quantity}x</span> {item.product_name}
                        {item.variant_name_snapshot ? <span className="text-muted"> ({item.variant_name_snapshot})</span> : null}
                      </p>
                      {item.order_item_modifiers.length > 0 ? (
                        <p className="text-xs text-muted">
                          + {item.order_item_modifiers.map((m) => (m.quantity > 1 ? `${m.quantity}x ${m.modifier_name}` : m.modifier_name)).join(", ")}
                        </p>
                      ) : null}
                      {item.notes ? <p className="text-xs italic text-muted">Obs.: {item.notes}</p> : null}
                    </div>
                    <p className="shrink-0 tabular-nums text-muted">{formatMoney(item.line_total_cents)}</p>
                  </li>
                ))}
              </ul>
            ) : null}

            {order.notes ? <p className="mt-3 text-sm text-muted">Observação do pedido: {order.notes}</p> : null}
          </li>
        );
      })}
    </ul>
  );
}
