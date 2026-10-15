"use client";

import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";
import { StickyNote, X } from "lucide-react";
import { Alert } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { FulfillmentBadge, StatusBadge } from "@/components/operations/status-badge";
import { createClient } from "@/lib/supabase/client";
import type { AppSupabaseClient } from "@/lib/supabase/types";
import { formatDateTime, formatMoney } from "@/modules/operations/format";
import { fetchOrderById } from "@/modules/operations/queries";
import {
  PAYMENT_METHOD_LABELS,
  PAYMENT_STATUS_LABELS,
  STATUS_LABELS,
  type OperationsOrder,
} from "@/modules/operations/types";
import { useOrderHistory } from "@/modules/operations/use-order-history";
import { documentLabel, fetchPrintJobs, PRINT_STATUS_LABELS, type PrintJobEntry } from "./history-model";

type HistoryDetailProps = {
  restaurantId: string;
  /** Pedido aberto; null = fechado. */
  orderId: string | null;
  onClose: () => void;
};

/** Painel lateral somente leitura (<dialog> modal: foco preso, Esc fecha). */
export function HistoryDetail({ orderId, onClose, restaurantId }: HistoryDetailProps) {
  const ref = useRef<HTMLDialogElement>(null);
  const open = orderId !== null;

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);

  return (
    <dialog
      ref={ref}
      aria-label="Detalhes do pedido"
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      onClick={(event) => {
        if (event.target === ref.current) onClose();
      }}
      className="m-0 mr-0 ml-auto h-dvh max-h-dvh w-full max-w-xl overflow-hidden border-l border-line bg-surface p-0 shadow-pop sm:w-[36rem]"
    >
      {orderId ? <DetailBody key={orderId} restaurantId={restaurantId} orderId={orderId} onClose={onClose} /> : null}
    </dialog>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="border-t border-line px-5 py-4">
      <h3 className="mb-2 text-sm font-semibold text-muted">{title}</h3>
      {children}
    </section>
  );
}

type OrderState = { order: OperationsOrder | null; failed: boolean; done: boolean };

function DetailBody({ restaurantId, orderId, onClose }: { restaurantId: string; orderId: string; onClose: () => void }) {
  const titleId = useId();
  const supabase = useMemo<AppSupabaseClient>(() => createClient(), []);
  const [state, setState] = useState<OrderState>({ order: null, failed: false, done: false });
  const [jobs, setJobs] = useState<PrintJobEntry[] | null>(null);
  const [jobsFailed, setJobsFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetchOrderById(supabase, restaurantId, orderId)
      .then((order) => {
        if (!cancelled) setState({ order, failed: false, done: true });
      })
      .catch(() => {
        if (!cancelled) setState({ order: null, failed: true, done: true });
      });
    fetchPrintJobs(supabase, restaurantId, orderId)
      .then((rows) => {
        if (!cancelled) setJobs(rows);
      })
      .catch(() => {
        if (!cancelled) setJobsFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [supabase, restaurantId, orderId]);

  const { order } = state;
  const { entries, failed: historyFailed } = useOrderHistory(restaurantId, orderId, order?.updated_at ?? "");
  const payment = order?.payment_method_intent
    ? (PAYMENT_METHOD_LABELS[order.payment_method_intent] ?? order.payment_method_intent)
    : null;

  return (
    <div className="flex h-dvh flex-col">
      <header className="flex items-start justify-between gap-3 px-5 py-4">
        <div className="min-w-0">
          <h2 id={titleId} className="text-2xl font-bold tabular-nums text-fg">
            {order ? `Pedido #${order.order_number}` : "Pedido"}
          </h2>
          {order ? (
            <>
              <div className="mt-2 flex flex-wrap items-center gap-1.5">
                <StatusBadge status={order.status} />
                <FulfillmentBadge type={order.fulfillment_type} label={order.table_label} />
                <Badge tone="neutral">{PAYMENT_STATUS_LABELS[order.payment_status] ?? order.payment_status}</Badge>
              </div>
              <p className="mt-2 text-sm text-muted">Recebido em {formatDateTime(order.created_at)}</p>
            </>
          ) : null}
        </div>
        <Button variant="ghost" size="lg" onClick={onClose} aria-label="Fechar detalhes" className="-mr-2 px-3">
          <X aria-hidden="true" className="size-5" />
        </Button>
      </header>

      <div className="flex-1 overflow-y-auto">
        {!state.done ? (
          <div className="flex flex-col gap-3 px-5 pb-4">
            <Skeleton className="h-6 w-2/3" />
            <Skeleton className="h-6 w-1/2" />
            <Skeleton className="h-24 w-full" />
          </div>
        ) : state.failed ? (
          <div className="px-5 pb-4">
            <Alert tone="danger" title="Não foi possível carregar o pedido">
              Feche e abra de novo para tentar outra vez.
            </Alert>
          </div>
        ) : !order ? (
          <div className="px-5 pb-4">
            <Alert tone="warning" title="Pedido não encontrado">
              Ele pode ter sido removido ou você não tem acesso a ele.
            </Alert>
          </div>
        ) : (
          <>
            {order.status_reason ? (
              <div className="px-5 pb-4">
                <Alert tone="danger" title={order.status === "REJECTED" ? "Pedido recusado" : "Motivo registrado"}>
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
                        {item.order_item_modifiers.map((modifier, index) => (
                          <p key={`${modifier.modifier_name}-${index}`} className="text-sm text-muted">
                            + {modifier.quantity > 1 ? `${modifier.quantity}x ` : ""}
                            {modifier.modifier_name}
                          </p>
                        ))}
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
                <p className="mt-3 rounded-control bg-warning-soft px-3 py-2 text-sm font-medium text-warning-soft-fg">
                  <span className="font-semibold">Observação do pedido: </span>
                  {order.notes}
                </p>
              ) : null}
            </Section>

            <Section title="Pagamento declarado">
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
                    Forma declarada pelo cliente: <span className="font-semibold">{payment}</span>.
                  </>
                ) : (
                  "Forma de pagamento não declarada."
                )}
                {order.payment_method_intent === "CASH" && order.change_for_cents ? (
                  <> Troco para {formatMoney(order.change_for_cents)}.</>
                ) : null}{" "}
                Situação: {PAYMENT_STATUS_LABELS[order.payment_status] ?? order.payment_status}.
              </p>
            </Section>

            <Section title="Linha do tempo">
              {historyFailed && !entries ? (
                <p className="text-sm text-danger">Não foi possível carregar a linha do tempo.</p>
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

            <Section title="Pedidos de impressão">
              {jobsFailed ? (
                <p className="text-sm text-danger">Não foi possível carregar as impressões.</p>
              ) : !jobs ? (
                <Skeleton className="h-5 w-2/3" />
              ) : jobs.length === 0 ? (
                <p className="text-sm text-muted">Nenhuma impressão pedida para este pedido.</p>
              ) : (
                <ul className="flex flex-col gap-2.5">
                  {jobs.map((job) => (
                    <li key={job.id} className="text-sm">
                      <p className="text-fg">
                        <span className="font-semibold">{documentLabel(job.document_type)}</span>
                        <span className="text-muted">
                          {" "}
                          {formatDateTime(job.created_at)} por {job.requestedByName ?? "usuário da equipe"}
                        </span>
                      </p>
                      <p className="text-muted">
                        {PRINT_STATUS_LABELS[job.status] ?? job.status}
                        {job.error_message ? `: ${job.error_message}` : ""}
                      </p>
                    </li>
                  ))}
                </ul>
              )}
            </Section>
          </>
        )}
      </div>
    </div>
  );
}
