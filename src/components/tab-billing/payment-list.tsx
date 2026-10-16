import { formatMoney, formatTime } from "@/modules/operations/format";
import { paymentMethodLabel, type TabPayment } from "@/modules/tab-billing/types";

/** Referência digitada pela equipe; a parte após "#" e as chaves "ui-" são só idempotência. */
function visibleReference(payment: TabPayment): string | null {
  const raw = payment.reference ?? payment.idempotency_key ?? "";
  if (!raw || raw.startsWith("ui-")) return null;
  const typed = raw.split("#")[0]?.trim() ?? "";
  return typed || null;
}

function PaymentRow({ payment }: { payment: TabPayment }) {
  const when = payment.paid_at ?? payment.created_at;
  const voided = payment.status != null && payment.status !== "PAID";
  const reference = visibleReference(payment);
  const details = [
    payment.method === "CASH" && payment.tendered_cents != null
      ? `recebido ${formatMoney(payment.tendered_cents)}${payment.change_cents ? `, troco ${formatMoney(payment.change_cents)}` : ""}`
      : null,
    reference ? `ref. ${reference}` : null,
    voided ? `não contabilizado (${payment.status})` : null,
  ].filter(Boolean);

  return (
    <li className="flex items-baseline justify-between gap-3 py-2.5">
      <div className="min-w-0">
        <p className="text-sm font-medium">
          {paymentMethodLabel(payment.method)}
          {when ? <span className="ml-2 font-normal text-muted">{formatTime(when)}</span> : null}
        </p>
        {details.length > 0 ? <p className="mt-0.5 text-xs text-muted [overflow-wrap:anywhere]">{details.join("; ")}</p> : null}
      </div>
      <p className={`shrink-0 text-sm font-semibold tabular-nums ${voided ? "text-muted line-through" : ""}`}>
        {formatMoney(payment.amount_cents)}
      </p>
    </li>
  );
}

export function PaymentList({ payments }: { payments: readonly TabPayment[] }) {
  return (
    <section aria-labelledby="tb-payments-title">
      <h3 id="tb-payments-title" className="text-sm font-semibold">
        Pagamentos registrados
      </h3>
      {payments.length === 0 ? (
        <p className="mt-2 text-sm text-muted">Nenhum pagamento registrado nesta comanda.</p>
      ) : (
        <ul className="mt-1 divide-y divide-line">
          {payments.map((payment) => (
            <PaymentRow key={payment.id} payment={payment} />
          ))}
        </ul>
      )}
    </section>
  );
}
