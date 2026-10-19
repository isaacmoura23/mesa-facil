import Link from "next/link";
import { ChevronRight, Mail, MapPin, Phone } from "lucide-react";
import { Badge, type BadgeTone } from "@/components/ui/badge";
import { Card, CardHeader } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { formatCents } from "@/lib/format";
import { fulfillmentLabel, formatInt, orderStatusLabel, type DateFormatters } from "@/modules/reports/format";
import type { CustomerAddress, CustomerDetail, CustomerOrder } from "@/modules/customers/schemas";

const STATUS_TONES: Record<string, BadgeTone> = {
  RECEIVED: "accent",
  CONFIRMED: "info",
  PREPARING: "warning",
  READY: "accent",
  OUT_FOR_DELIVERY: "info",
  COMPLETED: "neutral",
  CANCELLED: "danger",
  REJECTED: "danger",
};

export function CustomerStats({ detail, dates }: { detail: CustomerDetail; dates: DateFormatters }) {
  const { stats, customer } = detail;
  const items = [
    { label: "Pedidos", value: formatInt(stats.orders_count) },
    { label: "Total gasto", value: formatCents(stats.total_spent_cents) },
    { label: "Último pedido", value: dates.date(stats.last_order_at) },
    { label: "Cliente desde", value: dates.date(customer.created_at) },
  ];
  return (
    <div className="mb-5">
      <dl className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {items.map((item) => (
          <div key={item.label} className="rounded-card border border-line bg-surface px-4 py-3 shadow-card">
            <dt className="text-xs font-medium text-muted">{item.label}</dt>
            <dd className="mt-1 text-lg font-semibold tabular-nums text-fg">{item.value}</dd>
          </div>
        ))}
      </dl>
      <p className="mt-2 text-xs text-muted">O total gasto não inclui pedidos cancelados ou recusados.</p>
    </div>
  );
}

export function CustomerContact({ customer }: { customer: CustomerDetail["customer"] }) {
  return (
    <Card>
      <CardHeader title="Contato" />
      <dl className="flex flex-col gap-3 text-sm">
        <div className="flex items-start gap-2">
          <Phone aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-muted" />
          <div className="min-w-0">
            <dt className="sr-only">Telefone</dt>
            <dd className="break-words text-fg">{customer.phone || "Sem telefone"}</dd>
          </div>
        </div>
        <div className="flex items-start gap-2">
          <Mail aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-muted" />
          <div className="min-w-0">
            <dt className="sr-only">E-mail</dt>
            <dd className="break-all text-fg">{customer.email || "Sem e-mail"}</dd>
          </div>
        </div>
        {customer.notes ? (
          <div>
            <dt className="text-xs font-medium text-muted">Observações</dt>
            <dd className="mt-1 whitespace-pre-line break-words text-fg">{customer.notes}</dd>
          </div>
        ) : null}
      </dl>
    </Card>
  );
}

function addressLines(address: CustomerAddress): string[] {
  const street = [address.street, address.number].filter(Boolean).join(", ");
  const place = [address.neighborhood, [address.city, address.state].filter(Boolean).join("/")].filter(Boolean).join(" - ");
  return [
    street + (address.complement ? ` (${address.complement})` : ""),
    place,
    address.postal_code ? `CEP ${address.postal_code}` : "",
    address.reference ? `Referência: ${address.reference}` : "",
  ].filter(Boolean);
}

export function CustomerAddresses({ addresses }: { addresses: CustomerAddress[] }) {
  return (
    <Card>
      <CardHeader title="Endereços" description="Endereços usados nas entregas." />
      {addresses.length === 0 ? (
        <p className="text-sm text-muted">Nenhum endereço cadastrado.</p>
      ) : (
        <ul className="flex flex-col gap-4">
          {addresses.map((address) => (
            <li key={address.id} className="flex items-start gap-2 text-sm">
              <MapPin aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-muted" />
              <div className="min-w-0">
                <p className="flex flex-wrap items-center gap-2 font-medium text-fg">
                  {address.label || "Endereço"}
                  {address.is_default ? <Badge tone="accent">Principal</Badge> : null}
                </p>
                {addressLines(address).map((line) => (
                  <p key={line} className="break-words text-muted">
                    {line}
                  </p>
                ))}
              </div>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

function orderTitle(order: CustomerOrder): string {
  return order.order_number !== null && order.order_number !== "" ? `Pedido #${order.order_number}` : "Pedido";
}

export function CustomerOrders({
  slug,
  orders,
  total,
  dates,
}: {
  slug: string;
  orders: CustomerOrder[];
  total: number;
  dates: DateFormatters;
}) {
  if (orders.length === 0) {
    return <EmptyState title="Nenhum pedido ainda" description="Os pedidos deste cliente aparecem aqui." />;
  }
  return (
    <div>
      <ul className="overflow-hidden rounded-card border border-line bg-surface shadow-card">
        {orders.map((order, index) => (
          <li key={order.id} className={index > 0 ? "border-t border-line" : undefined}>
            <Link
              href={`/app/${slug}/pedidos/${order.id}`}
              className="grid grid-cols-[1fr_auto] items-center gap-x-4 gap-y-1 px-4 py-3.5 transition-colors hover:bg-surface-2 md:grid-cols-[minmax(0,1fr)_auto_auto] md:gap-x-6"
            >
              <span className="min-w-0">
                <span className="flex flex-wrap items-center gap-2">
                  <span className="font-medium text-fg">{orderTitle(order)}</span>
                  <Badge tone={STATUS_TONES[order.status] ?? "neutral"}>{orderStatusLabel(order.status)}</Badge>
                </span>
                <span className="mt-0.5 block text-sm text-muted">
                  {dates.dateTime(order.created_at)}, {fulfillmentLabel(order.fulfillment_type)}
                </span>
              </span>
              <span className="row-start-1 col-start-2 text-right font-semibold tabular-nums text-fg md:col-start-2 md:row-start-auto">
                {formatCents(order.total_cents)}
              </span>
              <ChevronRight aria-hidden="true" className="hidden size-4 text-muted md:col-start-3 md:block" />
            </Link>
          </li>
        ))}
      </ul>
      {total > orders.length ? (
        <p className="mt-2 text-sm text-muted">
          Exibindo os {formatInt(orders.length)} pedidos mais recentes de {formatInt(total)}.
        </p>
      ) : null}
    </div>
  );
}
