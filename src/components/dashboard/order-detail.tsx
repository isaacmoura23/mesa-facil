import type { ReactNode } from "react";
import { Badge } from "@/components/ui/badge";
import { Card, CardHeader } from "@/components/ui/card";
import { formatCents } from "@/lib/format";
import { STATUS_TONES, formatDateTimeTz } from "@/modules/dashboard/orders";
import type { OrderDetail } from "@/modules/dashboard/orders-queries";
import { paymentMethodName } from "@/modules/dashboard/types";
import { PRINT_STATUS_LABELS, documentLabel } from "@/components/history/history-model";
import { formatAddress, formatPhone } from "@/modules/operations/format";
import {
  FULFILLMENT_LABELS,
  PAYMENT_METHOD_LABELS,
  PAYMENT_STATUS_LABELS,
  STATUS_LABELS,
} from "@/modules/operations/types";

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="text-xs font-medium text-muted">{label}</dt>
      <dd className="mt-0.5 text-sm font-medium text-fg">{children}</dd>
    </div>
  );
}

function Quiet({ children }: { children: ReactNode }) {
  return <span className="font-normal text-muted">{children}</span>;
}

const SOURCE_LABELS: Record<string, string> = { PUBLIC_WEB: "Vitrine online", STAFF: "Lançado pela equipe" };

export function OrderSummary({ detail, timezone }: { detail: OrderDetail; timezone: string }) {
  const { order } = detail;
  const isDelivery = order.fulfillment_type === "DELIVERY";
  const address = isDelivery ? formatAddress(order.delivery_address) : [];
  return (
    <Card>
      <dl className="grid grid-cols-2 gap-x-6 gap-y-4 md:grid-cols-4">
        <Fact label="Criado em">{formatDateTimeTz(order.created_at, timezone)}</Fact>
        <Fact label="Última atualização">{formatDateTimeTz(order.updated_at, timezone)}</Fact>
        <Fact label="Origem">{SOURCE_LABELS[order.source] ?? <Quiet>Não informada</Quiet>}</Fact>
        <Fact label="Previsão de pronto">
          {order.estimated_ready_at ? formatDateTimeTz(order.estimated_ready_at, timezone) : <Quiet>Não informada</Quiet>}
        </Fact>
        <Fact label="Cliente">{order.customer_name ?? <Quiet>Não informado</Quiet>}</Fact>
        <Fact label="Telefone">{order.customer_phone ? formatPhone(order.customer_phone) : <Quiet>Não informado</Quiet>}</Fact>
        {order.fulfillment_type === "DINE_IN" ? (
          <Fact label="Mesa">{order.table_label ?? <Quiet>Não informada</Quiet>}</Fact>
        ) : null}
        {isDelivery ? (
          <div className="col-span-2 min-w-0 md:col-span-2">
            <dt className="text-xs font-medium text-muted">Endereço de entrega</dt>
            <dd className="mt-0.5 text-sm font-medium text-fg">
              {address.length > 0 ? (
                address.map((line) => (
                  <span key={line} className="block">
                    {line}
                  </span>
                ))
              ) : (
                <Quiet>Não informado</Quiet>
              )}
              {order.delivery_address?.complement ? (
                <span className="block font-normal text-muted">Complemento: {order.delivery_address.complement}</span>
              ) : null}
              {order.delivery_address?.instructions ? (
                <span className="block font-normal text-muted">Referência: {order.delivery_address.instructions}</span>
              ) : null}
            </dd>
          </div>
        ) : null}
        {order.status_reason ? (
          <div className="col-span-2 min-w-0 md:col-span-4">
            <dt className="text-xs font-medium text-muted">Motivo ({STATUS_LABELS[order.status].toLowerCase()})</dt>
            <dd className="mt-0.5 text-sm text-fg">{order.status_reason}</dd>
          </div>
        ) : null}
        {order.notes ? (
          <div className="col-span-2 min-w-0 md:col-span-4">
            <dt className="text-xs font-medium text-muted">Observações do pedido</dt>
            <dd className="mt-0.5 text-sm text-fg">{order.notes}</dd>
          </div>
        ) : null}
      </dl>
    </Card>
  );
}

export function OrderItems({ detail }: { detail: OrderDetail }) {
  const { order } = detail;
  return (
    <Card>
      <CardHeader title="Itens e totais" />
      {order.order_items.length === 0 ? (
        <p className="text-sm text-muted">Nenhum item registrado neste pedido.</p>
      ) : (
        <ul className="divide-y divide-line rounded-control border border-line">
          {order.order_items.map((item) => (
            <li key={item.id} className="flex items-start justify-between gap-4 px-4 py-3 text-sm">
              <div className="min-w-0">
                <p className="font-medium text-fg">
                  {item.quantity}x {item.product_name}
                  {item.variant_name_snapshot ? <span className="font-normal text-muted"> ({item.variant_name_snapshot})</span> : null}
                </p>
                {item.order_item_modifiers.length > 0 ? (
                  <ul className="mt-0.5 text-muted">
                    {item.order_item_modifiers.map((mod, index) => (
                      <li key={`${mod.modifier_name}-${index}`}>
                        {mod.quantity > 1 ? `${mod.quantity}x ` : ""}
                        {mod.modifier_name}
                        {mod.group_name ? ` (${mod.group_name})` : ""}
                        {mod.price_delta_cents !== 0 ? ` · ${mod.price_delta_cents > 0 ? "+" : "-"}${formatCents(Math.abs(mod.price_delta_cents))}` : ""}
                      </li>
                    ))}
                  </ul>
                ) : null}
                {item.notes ? <p className="mt-0.5 text-muted">Obs.: {item.notes}</p> : null}
              </div>
              <span className="shrink-0 tabular-nums text-fg">{formatCents(item.line_total_cents)}</span>
            </li>
          ))}
        </ul>
      )}
      <dl className="mt-4 ml-auto flex max-w-xs flex-col gap-1.5 text-sm">
        <div className="flex justify-between gap-4">
          <dt className="text-muted">Subtotal</dt>
          <dd className="tabular-nums text-fg">{formatCents(order.subtotal_cents)}</dd>
        </div>
        {order.fulfillment_type === "DELIVERY" || order.delivery_fee_cents > 0 ? (
          <div className="flex justify-between gap-4">
            <dt className="text-muted">Taxa de entrega</dt>
            <dd className="tabular-nums text-fg">{formatCents(order.delivery_fee_cents)}</dd>
          </div>
        ) : null}
        {order.discount_cents > 0 ? (
          <div className="flex justify-between gap-4">
            <dt className="text-muted">Desconto</dt>
            <dd className="tabular-nums text-fg">-{formatCents(order.discount_cents)}</dd>
          </div>
        ) : null}
        <div className="flex justify-between gap-4 border-t border-line pt-2 text-base font-semibold">
          <dt className="text-fg">Total</dt>
          <dd className="tabular-nums text-fg">{formatCents(order.total_cents)}</dd>
        </div>
      </dl>
    </Card>
  );
}

export function OrderPayment({ detail, timezone }: { detail: OrderDetail; timezone: string }) {
  const { order, payments } = detail;
  const intent = order.payment_method_intent
    ? (PAYMENT_METHOD_LABELS[order.payment_method_intent] ?? order.payment_method_intent)
    : null;
  return (
    <Card>
      <CardHeader title="Pagamento" description="O que o cliente declarou e o que a equipe registrou." />
      <dl className="grid grid-cols-2 gap-x-6 gap-y-4 md:grid-cols-3">
        <Fact label="Forma declarada">{intent ?? <Quiet>Não informada</Quiet>}</Fact>
        <Fact label="Situação">{PAYMENT_STATUS_LABELS[order.payment_status] ?? order.payment_status}</Fact>
        {order.change_for_cents ? <Fact label="Troco para">{formatCents(order.change_for_cents)}</Fact> : null}
      </dl>
      <h3 className="mt-5 text-sm font-semibold text-fg">Pagamentos registrados</h3>
      {payments === null ? (
        <p className="mt-2 text-sm text-muted">Seu papel não tem acesso aos pagamentos registrados.</p>
      ) : payments.length === 0 ? (
        <p className="mt-2 text-sm text-muted">Nenhum pagamento foi registrado para este pedido.</p>
      ) : (
        <ul className="mt-2 divide-y divide-line rounded-control border border-line">
          {payments.map((payment) => (
            <li key={payment.id} className="flex flex-wrap items-center justify-between gap-2 px-4 py-3 text-sm">
              <div className="min-w-0">
                <p className="flex flex-wrap items-center gap-2 font-medium text-fg">
                  {paymentMethodName(payment.method)}
                  <Badge tone={payment.status === "PAID" ? "accent" : "warning"}>
                    {PAYMENT_STATUS_LABELS[payment.status] ?? payment.status}
                  </Badge>
                </p>
                <p className="text-muted">{formatDateTimeTz(payment.paid_at ?? payment.created_at, timezone)}</p>
              </div>
              <span className="font-semibold tabular-nums text-fg">{formatCents(payment.amount_cents)}</span>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

export function OrderTimeline({ detail, timezone }: { detail: OrderDetail; timezone: string }) {
  const { history } = detail;
  return (
    <Card>
      <CardHeader title="Linha do tempo" description="Cada mudança de estado, com quem alterou e quando." />
      {history === null ? (
        <p className="text-sm text-muted">Não foi possível carregar o histórico deste pedido.</p>
      ) : history.length === 0 ? (
        <p className="text-sm text-muted">Sem mudanças de estado registradas.</p>
      ) : (
        <ol className="flex flex-col">
          {history.map((entry) => (
            <li key={entry.id} className="grid grid-cols-[6.5rem_1fr] gap-x-3 border-l-2 border-line py-2 pl-4">
              <time dateTime={entry.created_at} className="text-xs tabular-nums text-muted">
                {formatDateTimeTz(entry.created_at, timezone)}
              </time>
              <div className="min-w-0 text-sm">
                <p className="font-medium text-fg">
                  {entry.from_status ? `${STATUS_LABELS[entry.from_status]} → ${STATUS_LABELS[entry.to_status]}` : `Pedido criado: ${STATUS_LABELS[entry.to_status]}`}
                </p>
                <p className="text-muted">
                  {entry.changedByName ?? (entry.changed_by ? "Membro da equipe" : "Cliente ou sistema")}
                  {entry.reason ? ` · ${entry.reason}` : ""}
                </p>
              </div>
            </li>
          ))}
        </ol>
      )}
    </Card>
  );
}

export function OrderPrints({ detail, timezone }: { detail: OrderDetail; timezone: string }) {
  const { printJobs } = detail;
  return (
    <Card>
      <CardHeader title="Pedidos de impressão" description="Solicitações feitas pela equipe (somente consulta)." />
      {printJobs === null ? (
        <p className="text-sm text-muted">Seu papel não tem acesso aos pedidos de impressão.</p>
      ) : printJobs.length === 0 ? (
        <p className="text-sm text-muted">Nenhuma impressão foi solicitada para este pedido.</p>
      ) : (
        <ul className="divide-y divide-line rounded-control border border-line">
          {printJobs.map((job) => (
            <li key={job.id} className="flex flex-wrap items-center justify-between gap-2 px-4 py-3 text-sm">
              <div className="min-w-0">
                <p className="font-medium text-fg">{documentLabel(job.document_type)}</p>
                <p className="text-muted">
                  {formatDateTimeTz(job.created_at, timezone)}
                  {job.requestedByName ? ` · ${job.requestedByName}` : ""}
                </p>
              </div>
              <Badge tone={job.status === "FAILED" ? "danger" : "neutral"}>{PRINT_STATUS_LABELS[job.status] ?? job.status}</Badge>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

export function OrderHeaderBadges({ detail }: { detail: OrderDetail }) {
  const { order } = detail;
  return (
    <>
      <Badge tone={STATUS_TONES[order.status]}>{STATUS_LABELS[order.status]}</Badge>
      <Badge>{FULFILLMENT_LABELS[order.fulfillment_type]}</Badge>
    </>
  );
}
