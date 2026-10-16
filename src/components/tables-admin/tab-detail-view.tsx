import type { ReactNode } from "react";
import { Badge } from "@/components/ui/badge";
import { Card, CardHeader } from "@/components/ui/card";
import {
  ORDER_STATUS_LABELS,
  ORDER_STATUS_TONES,
  PAYMENT_STATUS_LABELS,
  formatFullDateTime,
  formatMoney,
  formatTime,
  paymentMethodLabel,
} from "@/modules/tables-admin/format";
import type { TabDetail, TimelineEntry } from "@/modules/tables-admin/types";

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

export function TabSummaryCard({ detail }: { detail: TabDetail }) {
  const { tab } = detail;
  const balance =
    detail.consumedCents !== null && detail.paidCents !== null ? detail.consumedCents - detail.paidCents : null;
  const place = detail.tableName ?? (tab.table_id ? "Mesa removida" : "Balcão (sem mesa)");

  return (
    <Card>
      <dl className="grid grid-cols-2 gap-x-6 gap-y-4 md:grid-cols-4">
        <Fact label="Local">
          {place}
          {tab.label ? <Quiet> ({tab.label})</Quiet> : null}
        </Fact>
        <Fact label="Pessoas">{tab.guests ?? <Quiet>Não informado</Quiet>}</Fact>
        <Fact label="Aberta">
          {formatFullDateTime(tab.opened_at)}
          <span className="block font-normal text-muted">{detail.openedByName ?? "Responsável não identificado"}</span>
        </Fact>
        <Fact label="Encerrada">
          {tab.closed_at ? (
            <>
              {formatFullDateTime(tab.closed_at)}
              <span className="block font-normal text-muted">{detail.closedByName ?? "Responsável não identificado"}</span>
            </>
          ) : (
            <Quiet>Em andamento</Quiet>
          )}
        </Fact>
        <Fact label={tab.status === "OPEN" ? "Consumo parcial" : "Consumo"}>
          {detail.consumedCents === null ? <Quiet>Indisponível</Quiet> : formatMoney(detail.consumedCents)}
        </Fact>
        <Fact label="Pago">{detail.paidCents === null ? <Quiet>Indisponível</Quiet> : formatMoney(detail.paidCents)}</Fact>
        <Fact label={balance !== null && balance < 0 ? "Pago a mais" : "Saldo"}>
          {balance === null ? <Quiet>Indisponível</Quiet> : formatMoney(Math.abs(balance))}
        </Fact>
        {tab.status === "CLOSED" ? <Fact label="Total fechado">{formatMoney(tab.total_cents)}</Fact> : null}
        {tab.status === "CANCELLED" && tab.status_reason ? (
          <div className="col-span-2 min-w-0 md:col-span-4">
            <dt className="text-xs font-medium text-muted">Motivo do cancelamento</dt>
            <dd className="mt-0.5 text-sm text-fg">{tab.status_reason}</dd>
          </div>
        ) : null}
      </dl>
    </Card>
  );
}

export function TabOrders({ detail }: { detail: TabDetail }) {
  return (
    <Card>
      <CardHeader title="Pedidos e itens" description="Tudo o que foi lançado nesta comanda." />
      {detail.orders === null ? (
        <p className="text-sm text-muted">Seu papel não tem acesso aos pedidos.</p>
      ) : detail.orders.length === 0 ? (
        <p className="text-sm text-muted">Nenhum pedido foi lançado nesta comanda.</p>
      ) : (
        <ul className="flex flex-col gap-4">
          {detail.orders.map((order) => (
            <li key={order.id} className="rounded-control border border-line">
              <div className="flex flex-wrap items-center justify-between gap-2 border-b border-line bg-surface-2 px-4 py-2.5">
                <div className="flex flex-wrap items-center gap-2">
                  <h3 className="text-sm font-semibold text-fg">Pedido #{order.order_number}</h3>
                  <Badge tone={ORDER_STATUS_TONES[order.status]}>{ORDER_STATUS_LABELS[order.status]}</Badge>
                  <span className="text-xs text-muted">às {formatTime(order.created_at)}</span>
                </div>
                <span className="text-sm font-semibold tabular-nums text-fg">{formatMoney(order.total_cents)}</span>
              </div>
              {order.items.length === 0 ? (
                <p className="px-4 py-3 text-sm text-muted">Sem itens registrados.</p>
              ) : (
                <ul className="divide-y divide-line">
                  {order.items.map((item) => (
                    <li key={item.id} className="flex items-start justify-between gap-4 px-4 py-2.5 text-sm">
                      <div className="min-w-0">
                        <p className="font-medium text-fg">
                          {item.quantity}x {item.product_name}
                        </p>
                        {item.modifiers.length > 0 ? (
                          <p className="text-muted">
                            {item.modifiers
                              .map((mod) => (mod.quantity > 1 ? `${mod.quantity}x ${mod.modifier_name}` : mod.modifier_name))
                              .join(", ")}
                          </p>
                        ) : null}
                        {item.notes ? <p className="text-muted">Obs.: {item.notes}</p> : null}
                      </div>
                      <span className="shrink-0 tabular-nums text-fg">{formatMoney(item.line_total_cents)}</span>
                    </li>
                  ))}
                </ul>
              )}
              {order.notes ? <p className="border-t border-line px-4 py-2.5 text-sm text-muted">Obs. do pedido: {order.notes}</p> : null}
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

export function TabPayments({ detail }: { detail: TabDetail }) {
  return (
    <Card>
      <CardHeader title="Pagamentos registrados" description="Registros manuais feitos pela equipe do caixa." />
      {detail.payments === null ? (
        <p className="text-sm text-muted">Seu papel não tem acesso aos pagamentos.</p>
      ) : detail.payments.length === 0 ? (
        <p className="text-sm text-muted">Nenhum pagamento foi registrado.</p>
      ) : (
        <ul className="divide-y divide-line rounded-control border border-line">
          {detail.payments.map((payment) => (
            <li key={payment.id} className="flex flex-wrap items-center justify-between gap-2 px-4 py-3 text-sm">
              <div className="min-w-0">
                <p className="flex flex-wrap items-center gap-2 font-medium text-fg">
                  {paymentMethodLabel(payment.method)}
                  {payment.status !== "PAID" ? (
                    <Badge tone="warning">{PAYMENT_STATUS_LABELS[payment.status] ?? "Outro estado"}</Badge>
                  ) : null}
                </p>
                <p className="text-muted">
                  {formatFullDateTime(payment.paid_at ?? payment.created_at)}
                  {payment.recordedByName ? ` · ${payment.recordedByName}` : ""}
                </p>
              </div>
              <span className="font-semibold tabular-nums text-fg">{formatMoney(payment.amount_cents)}</span>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

const KIND_LABEL: Record<TimelineEntry["kind"], string> = {
  tab: "Comanda",
  order: "Pedido",
  payment: "Pagamento",
};

export function TabTimeline({ entries }: { entries: TimelineEntry[] }) {
  return (
    <Card>
      <CardHeader title="Linha do tempo" description="Abertura, pedidos, pagamentos e encerramento, em ordem." />
      {entries.length === 0 ? (
        <p className="text-sm text-muted">Sem eventos registrados.</p>
      ) : (
        <ol className="flex flex-col">
          {entries.map((entry, index) => (
            <li key={`${entry.at}-${index}`} className="grid grid-cols-[4.5rem_1fr] gap-x-3 border-l-2 border-line py-2 pl-4">
              <time dateTime={entry.at} className="text-xs tabular-nums text-muted">
                {formatFullDateTime(entry.at).slice(0, 5)}
                <span className="block">{formatTime(entry.at)}</span>
              </time>
              <div className="min-w-0 text-sm">
                <p className="font-medium text-fg">
                  <span className="sr-only">{KIND_LABEL[entry.kind]}: </span>
                  {entry.title}
                </p>
                {entry.detail || entry.actor ? (
                  <p className="text-muted">{[entry.detail, entry.actor].filter(Boolean).join(" · ")}</p>
                ) : null}
              </div>
            </li>
          ))}
        </ol>
      )}
    </Card>
  );
}
