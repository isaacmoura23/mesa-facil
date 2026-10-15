import { formatCents } from "@/lib/format";
import { PAYMENT_METHOD_LABELS } from "@/modules/orders-server/schemas";
import type { TrackedOrder } from "@/modules/orders-server/tracking";
import { PAYMENT_STATUS_LABELS } from "@/modules/storefront/order-status";
import { FULFILLMENT_LABELS } from "@/modules/storefront/schemas";

function Row({ label, value, strong }: { label: string; value: string; strong?: boolean }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <dt className={strong ? "text-base font-semibold text-fg" : "text-sm text-muted"}>{label}</dt>
      <dd className={strong ? "text-lg font-semibold tabular-nums text-fg" : "text-sm tabular-nums text-fg"}>
        {value}
      </dd>
    </div>
  );
}

/** Itens, totais, modalidade e forma de pagamento declarada. Sem dados pessoais. */
export function OrderDetails({ order }: { order: TrackedOrder }) {
  const payWhen =
    order.fulfillmentType === "DELIVERY"
      ? "na entrega"
      : order.fulfillmentType === "PICKUP"
        ? "na retirada"
        : "no restaurante";

  return (
    <div className="space-y-5">
      <ul className="divide-y divide-line" aria-label="Itens do pedido">
        {order.items.map((item, index) => (
          <li key={`${item.name}-${index}`} className="flex gap-3 py-3 first:pt-0 last:pb-0">
            <span className="w-7 shrink-0 text-sm font-semibold tabular-nums text-fg">{item.quantity}x</span>
            <div className="min-w-0 flex-1">
              <p className="text-sm font-medium text-fg">
                {item.name}
                {item.variantName ? <span className="font-normal text-muted"> ({item.variantName})</span> : null}
              </p>
              {item.modifiers.length > 0 ? (
                <p className="text-sm text-muted">{item.modifiers.map((m) => m.name).join(", ")}</p>
              ) : null}
            </div>
            <span className="shrink-0 text-sm tabular-nums text-fg">{formatCents(item.lineTotalCents)}</span>
          </li>
        ))}
      </ul>

      <dl className="space-y-1.5 border-t border-line pt-4">
        <Row label="Subtotal" value={formatCents(order.subtotalCents)} />
        {order.fulfillmentType === "DELIVERY" ? (
          <Row label="Taxa de entrega" value={formatCents(order.deliveryFeeCents)} />
        ) : null}
        {order.discountCents > 0 ? (
          <Row label="Desconto" value={`- ${formatCents(order.discountCents)}`} />
        ) : null}
        <Row label="Total" value={formatCents(order.totalCents)} strong />
      </dl>

      <dl className="space-y-1.5 border-t border-line pt-4">
        <Row label="Modalidade" value={FULFILLMENT_LABELS[order.fulfillmentType]} />
        {order.neighborhood ? <Row label="Entrega no bairro" value={order.neighborhood} /> : null}
        <Row
          label="Pagamento"
          value={
            order.paymentMethod
              ? `${PAYMENT_METHOD_LABELS[order.paymentMethod]} ${payWhen}`
              : "A combinar com o restaurante"
          }
        />
        <Row label="Situação" value={PAYMENT_STATUS_LABELS[order.paymentStatus] ?? "A pagar"} />
      </dl>
    </div>
  );
}
