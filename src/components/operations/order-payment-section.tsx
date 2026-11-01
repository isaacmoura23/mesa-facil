"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Alert } from "@/components/ui/alert";
import { Skeleton } from "@/components/ui/skeleton";
import { PaymentForm } from "@/components/tab-billing/payment-form";
import { createClient } from "@/lib/supabase/client";
import type { AppSupabaseClient } from "@/lib/supabase/types";
import { formatDateTime, formatMoney } from "@/modules/operations/format";
import type { OperationsOrder } from "@/modules/operations/types";
import { PAYMENT_METHOD_LABELS, type PaymentMethod } from "@/modules/tab-billing/types";

type PaymentRow = { id: string; method: PaymentMethod; amount_cents: number; status: string; paid_at: string | null };

type Props = {
  order: OperationsOrder;
  restaurantId: string;
  /** Depois de gravar um pagamento: o painel relê o pedido (status de pagamento). */
  onRecorded: () => void | Promise<void>;
};

/**
 * Receber o pagamento de um pedido de retirada/entrega (a mesma calculadora de troco das comandas).
 * O dinheiro recebido entra sozinho no caixa (venda em dinheiro). A autoridade é o banco: a RPC valida
 * permissão, saldo e idempotência.
 */
export function OrderPaymentSection({ order, restaurantId, onRecorded }: Props) {
  const supabase = useMemo<AppSupabaseClient>(() => createClient(), []);
  const [payments, setPayments] = useState<PaymentRow[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async () => {
    const { data, error } = await supabase
      .from("payments")
      .select("id, method, amount_cents, status, paid_at")
      .eq("restaurant_id", restaurantId)
      .eq("order_id", order.id)
      .order("created_at", { ascending: true });
    if (error) {
      setFailed(true);
      return;
    }
    setFailed(false);
    setPayments((data ?? []) as PaymentRow[]);
  }, [supabase, restaurantId, order.id]);

  useEffect(() => {
    void Promise.resolve().then(load);
  }, [load]);

  const paid = (payments ?? []).filter((p) => p.status === "PAID").reduce((n, p) => n + p.amount_cents, 0);
  const remaining = Math.max(order.total_cents - paid, 0);

  if (failed && !payments) return <Alert tone="danger">Não foi possível carregar os pagamentos deste pedido.</Alert>;
  if (!payments) return <Skeleton className="h-16" />;

  return (
    <div className="flex flex-col gap-3">
      {payments.length > 0 ? (
        <ul className="flex flex-col gap-1 text-sm" aria-label="Pagamentos registrados">
          {payments.map((p) => (
            <li key={p.id} className="flex justify-between gap-3">
              <span className="text-fg">
                {PAYMENT_METHOD_LABELS[p.method] ?? p.method}
                {p.paid_at ? <span className="text-muted"> · {formatDateTime(p.paid_at)}</span> : null}
              </span>
              <span className="font-semibold tabular-nums">{formatMoney(p.amount_cents)}</span>
            </li>
          ))}
        </ul>
      ) : null}

      <p className="text-sm text-muted">
        Pago <span className="font-semibold text-fg tabular-nums">{formatMoney(paid)}</span> de{" "}
        <span className="tabular-nums">{formatMoney(order.total_cents)}</span>
        {remaining > 0 ? (
          <>
            {" "}
            · falta <span className="font-semibold text-fg tabular-nums">{formatMoney(remaining)}</span>
          </>
        ) : null}
      </p>

      {notice ? <Alert tone="success">{notice}</Alert> : null}

      {remaining > 0 ? (
        <PaymentForm
          supabase={supabase}
          orderId={order.id}
          remainingCents={remaining}
          onStale={load}
          onRecorded={async (message) => {
            setNotice(message);
            await load();
            await onRecorded();
          }}
          onAttempt={() => setNotice(null)}
        />
      ) : (
        <Alert tone="success">Pedido totalmente pago.</Alert>
      )}
    </div>
  );
}
