"use client";

import { useEffect, useId, useRef } from "react";
import { MapPin, Phone, StickyNote, X } from "lucide-react";
import { Alert } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import {
  formatAddress,
  formatDateTime,
  formatMoney,
  formatPhone,
} from "@/modules/operations/format";
import {
  PAYMENT_METHOD_LABELS,
  PAYMENT_STATUS_LABELS,
  STATUS_LABELS,
  type OperationsOrder,
} from "@/modules/operations/types";
import type { OrderAction } from "@/modules/operations/use-order-actions";
import { useOrderHistory } from "@/modules/operations/use-order-history";
import { PrintButton } from "./print-button";
import { FulfillmentBadge, StatusBadge } from "./status-badge";

type DrawerProps = {
  order: OperationsOrder | null;
  restaurantId: string;
  actions: OrderAction[];
  busy: boolean;
  canPrint: boolean;
  onClose: () => void;
  onAction: (order: OperationsOrder, action: OrderAction) => void;
};

/** Painel lateral (<dialog> modal: foco preso, Esc fecha). Em celular ocupa a tela toda. */
export function OrderDetailDrawer({ order, onClose, ...rest }: DrawerProps) {
  const ref = useRef<HTMLDialogElement>(null);
  const open = order !== null;

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);

  return (
    <dialog
      ref={ref}
      aria-label={order ? `Detalhes do pedido ${order.order_number}` : "Detalhes do pedido"}
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      onClick={(event) => {
        if (event.target === ref.current) onClose();
      }}
      className="m-0 mr-0 ml-auto h-dvh max-h-dvh w-full max-w-xl overflow-hidden border-l border-line bg-surface p-0 shadow-pop sm:w-[36rem]"
    >
      {order ? <DrawerBody key={order.id} order={order} onClose={onClose} {...rest} /> : null}
    </dialog>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="border-t border-line px-5 py-4">
      <h3 className="mb-2 text-sm font-semibold text-muted">{title}</h3>
      {children}
    </section>
  );
}

function DrawerBody({
  order,
  restaurantId,
  actions,
  busy,
  canPrint,
  onClose,
  onAction,
}: Omit<DrawerProps, "order"> & { order: OperationsOrder }) {
  const titleId = useId();
  const { entries, failed } = useOrderHistory(restaurantId, order.id, order.updated_at);
  const address = formatAddress(order.delivery_address);
  const payment = order.payment_method_intent
    ? (PAYMENT_METHOD_LABELS[order.payment_method_intent] ?? order.payment_method_intent)
    : null;
  const advance = actions.find((action) => action.kind === "advance");
  const others = actions.filter((action) => action !== advance);

  return (
    <div className="flex h-dvh flex-col">
      <header className="flex items-start justify-between gap-3 px-5 py-4">
        <div className="min-w-0">
          <h2 id={titleId} className="text-2xl font-bold tabular-nums text-fg">
            Pedido #{order.order_number}
          </h2>
          <div className="mt-2 flex flex-wrap items-center gap-1.5">
            <StatusBadge status={order.status} />
            <FulfillmentBadge type={order.fulfillment_type} label={order.table_label} />
            <Badge tone="neutral">
              {PAYMENT_STATUS_LABELS[order.payment_status] ?? order.payment_status}
            </Badge>
          </div>
          <p className="mt-2 text-sm text-muted">Recebido em {formatDateTime(order.created_at)}</p>
        </div>
        <Button variant="ghost" size="lg" onClick={onClose} aria-label="Fechar detalhes" className="-mr-2 px-3">
          <X aria-hidden="true" className="size-5" />
        </Button>
      </header>

      <div className="flex-1 overflow-y-auto">
        {order.status_reason ? (
          <div className="px-5 pb-4">
            <Alert tone="danger" title={order.status === "REJECTED" ? "Pedido recusado" : "Pedido cancelado"}>
              {order.status_reason}
            </Alert>
          </div>
        ) : null}

        <Section title="Itens">
          {order.order_items.length === 0 ? (
            <p className="text-sm text-muted">Nenhum item registrado.</p>
          ) : (
            <ul className="flex flex-col gap-3">
              {order.order_items.map((item) => (
                <li key={item.id} className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="text-base font-semibold text-fg">
                      <span className="tabular-nums">{item.quantity}x</span> {item.product_name}
                      {item.variant_name_snapshot ? (
                        <span className="font-normal text-muted"> ({item.variant_name_snapshot})</span>
                      ) : null}
                    </p>
                    {item.order_item_modifiers.length > 0 ? (
                      <ul className="mt-0.5 text-sm text-muted">
                        {item.order_item_modifiers.map((modifier, index) => (
                          <li key={`${modifier.modifier_name}-${index}`}>
                            + {modifier.quantity > 1 ? `${modifier.quantity}x ` : ""}
                            {modifier.modifier_name}
                            {modifier.price_delta_cents > 0
                              ? ` (${formatMoney(modifier.price_delta_cents)})`
                              : ""}
                          </li>
                        ))}
                      </ul>
                    ) : null}
                    {item.notes ? (
                      <p className="mt-1 flex items-start gap-1.5 rounded-control bg-warning-soft px-2 py-1 text-sm font-medium text-warning-soft-fg">
                        <StickyNote aria-hidden="true" className="mt-0.5 size-3.5 shrink-0" />
                        {item.notes}
                      </p>
                    ) : null}
                  </div>
                  <p className="shrink-0 text-sm font-medium tabular-nums text-fg">
                    {formatMoney(item.line_total_cents)}
                  </p>
                </li>
              ))}
            </ul>
          )}
          {order.notes ? (
            <p className="mt-4 flex items-start gap-1.5 rounded-control bg-warning-soft px-3 py-2 text-sm font-medium text-warning-soft-fg">
              <StickyNote aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
              <span>
                <span className="font-semibold">Observação do pedido: </span>
                {order.notes}
              </span>
            </p>
          ) : null}
        </Section>

        <Section title="Cliente">
          <p className="text-base font-medium text-fg">{order.customer_name?.trim() || "Sem nome informado"}</p>
          {order.customer_phone ? (
            <a
              href={`tel:${order.customer_phone}`}
              className="mt-1 inline-flex items-center gap-1.5 text-sm font-medium text-fg underline underline-offset-4"
            >
              <Phone aria-hidden="true" className="size-4" />
              {formatPhone(order.customer_phone)}
            </a>
          ) : null}
          {order.fulfillment_type === "DELIVERY" ? (
            <div className="mt-3 flex items-start gap-2 text-sm text-fg">
              <MapPin aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-muted" />
              <div>
                {address.length === 0 ? <p>Endereço não informado.</p> : null}
                {address.map((line) => (
                  <p key={line}>{line}</p>
                ))}
                {order.delivery_address?.complement ? <p>Compl.: {order.delivery_address.complement}</p> : null}
                {order.delivery_address?.instructions ? (
                  <p className="mt-1 font-medium">Ref.: {order.delivery_address.instructions}</p>
                ) : null}
              </div>
            </div>
          ) : null}
        </Section>

        <Section title="Pagamento">
          <dl className="grid grid-cols-[1fr_auto] gap-x-4 gap-y-1 text-sm">
            <dt className="text-muted">Subtotal</dt>
            <dd className="text-right tabular-nums">{formatMoney(order.subtotal_cents)}</dd>
            {order.delivery_fee_cents > 0 ? (
              <>
                <dt className="text-muted">Taxa de entrega</dt>
                <dd className="text-right tabular-nums">{formatMoney(order.delivery_fee_cents)}</dd>
              </>
            ) : null}
            {order.discount_cents > 0 ? (
              <>
                <dt className="text-muted">Desconto</dt>
                <dd className="text-right tabular-nums">-{formatMoney(order.discount_cents)}</dd>
              </>
            ) : null}
            <dt className="pt-1 text-base font-semibold text-fg">Total</dt>
            <dd className="pt-1 text-right text-base font-semibold tabular-nums text-fg">
              {formatMoney(order.total_cents)}
            </dd>
          </dl>
          <p className="mt-3 text-sm text-fg">
            {payment ? (
              <>
                Cliente pagará em <span className="font-semibold">{payment}</span> na{" "}
                {order.fulfillment_type === "DELIVERY" ? "entrega" : "retirada"}.
              </>
            ) : (
              "Forma de pagamento não declarada."
            )}
            {order.payment_method_intent === "CASH" && order.change_for_cents ? (
              <>
                {" "}
                Troco para <span className="font-semibold">{formatMoney(order.change_for_cents)}</span> (levar{" "}
                {formatMoney(Math.max(0, order.change_for_cents - order.total_cents))}).
              </>
            ) : null}
          </p>
        </Section>

        <Section title="Histórico">
          {failed && !entries ? (
            <p className="text-sm text-danger">Não foi possível carregar o histórico.</p>
          ) : !entries ? (
            <div className="flex flex-col gap-2">
              <Skeleton className="h-5 w-3/4" />
              <Skeleton className="h-5 w-1/2" />
            </div>
          ) : entries.length === 0 ? (
            <p className="text-sm text-muted">Sem registros.</p>
          ) : (
            <ol className="flex flex-col gap-2.5">
              {entries.map((entry) => (
                <li key={entry.id} className="text-sm">
                  <p className="text-fg">
                    <span className="font-semibold">{STATUS_LABELS[entry.to_status]}</span>
                    <span className="text-muted">
                      {" "}
                      {formatDateTime(entry.created_at)}
                      {entry.changed_by
                        ? ` por ${entry.changedByName ?? "usuário da equipe"}`
                        : entry.from_status === null
                          ? " (pedido recebido)"
                          : " (sistema)"}
                    </span>
                  </p>
                  {entry.reason ? <p className="text-muted">Motivo: {entry.reason}</p> : null}
                </li>
              ))}
            </ol>
          )}
        </Section>
      </div>

      <footer className="flex flex-wrap items-center gap-2 border-t border-line bg-surface p-4">
        {advance ? (
          <Button size="lg" className="min-w-0 flex-1" loading={busy} onClick={() => onAction(order, advance)}>
            {advance.label}
          </Button>
        ) : null}
        {others.map((action) => (
          <Button
            key={action.to}
            size="lg"
            variant={action.kind === "cancel" ? "secondary" : "danger"}
            disabled={busy}
            onClick={() => onAction(order, action)}
          >
            {action.label}
          </Button>
        ))}
        <PrintButton order={order} allowed={canPrint} size="lg" />
      </footer>
    </div>
  );
}
