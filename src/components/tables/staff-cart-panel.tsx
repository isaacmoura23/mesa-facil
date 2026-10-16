"use client";

import { useState } from "react";
import { Send, Trash2 } from "lucide-react";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { formatCents } from "@/lib/format";
import { estimatedLineCents, type CartLine } from "@/modules/storefront/cart";
import { QuantityStepper } from "@/components/storefront/quantity-stepper";
import { staffCartCount, staffCartEstimate } from "@/modules/tables/staff-cart";

const MAX_ORDER_NOTES = 300;

type StaffCartPanelProps = {
  lines: CartLine[];
  orderNotes: string;
  onOrderNotesChange: (value: string) => void;
  onQuantity: (lineId: string, quantity: number) => void;
  onRemove: (lineId: string) => void;
  onClear: () => void;
  onSend: () => void;
  sending: boolean;
  /** Erro da última tentativa de envio (o carrinho é mantido). */
  sendError: string | null;
  destination: string;
};

/** Resumo do pedido em montagem + confirmação antes de enviar à cozinha. */
export function StaffCartPanel({
  lines,
  orderNotes,
  onOrderNotesChange,
  onQuantity,
  onRemove,
  onClear,
  onSend,
  sending,
  sendError,
  destination,
}: StaffCartPanelProps) {
  const [confirming, setConfirming] = useState(false);
  const count = staffCartCount(lines);
  const estimate = staffCartEstimate(lines);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center justify-between gap-2 border-b border-line px-5 py-3">
        <h3 className="text-base font-semibold text-fg">
          Pedido {count > 0 ? <span className="font-normal text-muted">({count} {count === 1 ? "item" : "itens"})</span> : null}
        </h3>
        {lines.length > 0 ? (
          <button
            type="button"
            onClick={onClear}
            disabled={sending}
            className="inline-flex h-10 items-center rounded-control px-2 text-sm font-medium text-muted hover:bg-surface-2 hover:text-fg disabled:opacity-50"
          >
            Limpar
          </button>
        ) : null}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-5 py-3">
        {lines.length === 0 ? (
          <p className="py-8 text-center text-sm text-muted">
            Nenhum item ainda. Escolha itens no cardápio para montar o pedido.
          </p>
        ) : (
          <ul className="divide-y divide-line">
            {lines.map((line) => (
              <li key={line.id} className="py-3">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="font-medium text-fg">
                      {line.snapshot.name}
                      {line.snapshot.variantName ? <span className="text-muted"> ({line.snapshot.variantName})</span> : null}
                    </p>
                    {line.snapshot.modifiers.length > 0 ? (
                      <p className="text-xs text-muted">+ {line.snapshot.modifiers.map((m) => m.name).join(", ")}</p>
                    ) : null}
                    {line.notes ? <p className="text-xs italic text-muted">Obs.: {line.notes}</p> : null}
                  </div>
                  <p className="shrink-0 text-sm font-semibold tabular-nums text-fg">{formatCents(estimatedLineCents(line))}</p>
                </div>
                <div className="mt-2 flex items-center justify-between">
                  <QuantityStepper
                    value={line.quantity}
                    onChange={(next) => onQuantity(line.id, next)}
                    label={line.snapshot.name}
                    removeAtOne
                    size="sm"
                  />
                  <button
                    type="button"
                    onClick={() => onRemove(line.id)}
                    disabled={sending}
                    aria-label={`Remover ${line.snapshot.name} do pedido`}
                    className="flex size-10 items-center justify-center rounded-control text-muted hover:bg-danger-soft hover:text-danger-soft-fg disabled:opacity-50"
                  >
                    <Trash2 aria-hidden="true" className="size-4" />
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}

        {lines.length > 0 ? (
          <div className="mt-2">
            <label htmlFor="staff-order-notes" className="text-sm font-medium text-fg">
              Observação para a cozinha (opcional)
            </label>
            <textarea
              id="staff-order-notes"
              value={orderNotes}
              onChange={(event) => onOrderNotesChange(event.target.value.slice(0, MAX_ORDER_NOTES))}
              rows={2}
              maxLength={MAX_ORDER_NOTES}
              className="mt-2 block w-full resize-y rounded-control border border-line bg-surface px-3 py-2.5 text-base text-fg hover:border-line-strong sm:text-sm"
            />
          </div>
        ) : null}
      </div>

      <div className="space-y-3 border-t border-line bg-surface px-5 py-3">
        {sendError ? (
          <Alert tone="danger" title="Pedido não enviado">
            {sendError} O pedido continua aqui para você tentar de novo.
          </Alert>
        ) : null}
        <div className="flex items-baseline justify-between">
          <span className="text-sm text-muted">Total estimado</span>
          <span className="text-xl font-semibold tabular-nums text-fg">{formatCents(estimate)}</span>
        </div>
        <Button size="lg" fullWidth disabled={lines.length === 0 || sending} loading={sending} onClick={() => setConfirming(true)}>
          <Send aria-hidden="true" className="size-4" />
          Enviar para a cozinha
        </Button>
        <p className="text-xs text-muted">O valor final é calculado pelo sistema ao enviar.</p>
      </div>

      <ConfirmDialog
        open={confirming}
        title="Enviar pedido para a cozinha?"
        description={`${count} ${count === 1 ? "item" : "itens"} para ${destination}, total estimado de ${formatCents(estimate)}. O pedido entra confirmado e a cozinha já o recebe.`}
        confirmLabel="Enviar pedido"
        pending={sending}
        onClose={() => setConfirming(false)}
        onConfirm={() => {
          setConfirming(false);
          onSend();
        }}
      />
    </div>
  );
}
