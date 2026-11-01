"use client";

import { useState } from "react";
import { FormDialog, FormError } from "@/components/menu-admin/form-dialog";
import { Button } from "@/components/ui/button";
import { TextField } from "@/components/ui/input";
import { changeBreakdown, changeFor, shortfallFor, tenderSuggestions } from "@/modules/cash/money";
import { formatMoney } from "@/modules/operations/format";
import { centsToInput, parseMoneyToCents } from "@/modules/tab-billing/money";

type CounterPaymentDialogProps = {
  open: boolean;
  totalCents: number;
  sending: boolean;
  error: string | null;
  onClose: () => void;
  /** `null` = valor exato (sem troco). */
  onConfirm: (tenderedCents: number | null) => void;
};

/** Recebimento em dinheiro da venda de balcão: valor recebido, troco automático e quebra em notas e moedas. */
export function CounterPaymentDialog({ open, totalCents, sending, error, onClose, onConfirm }: CounterPaymentDialogProps) {
  return (
    <FormDialog open={open} title="Receber e finalizar" description="Pagamento em dinheiro" locked={sending} onClose={onClose}>
      <PaymentForm totalCents={totalCents} sending={sending} error={error} onClose={onClose} onConfirm={onConfirm} />
    </FormDialog>
  );
}

function PaymentForm({ totalCents, sending, error, onClose, onConfirm }: Omit<CounterPaymentDialogProps, "open">) {
  const [tenderedText, setTenderedText] = useState("");
  const typed = tenderedText.trim() ? parseMoneyToCents(tenderedText) : null;
  // Campo vazio = valor exato.
  const tendered = tenderedText.trim() ? typed : totalCents;
  const change = changeFor(totalCents, tendered);
  const shortfall = shortfallFor(totalCents, tendered);
  const suggestions = tenderSuggestions(totalCents);
  const invalid = tenderedText.trim() !== "" && typed === null;
  const canConfirm = !sending && totalCents > 0 && change !== null;

  return (
    <form
      className="flex flex-col gap-4"
      onSubmit={(event) => {
        event.preventDefault();
        if (canConfirm) onConfirm(tenderedText.trim() ? typed : null);
      }}
    >
      <div className="rounded-control bg-surface-2 px-4 py-3">
        <p className="text-sm text-muted">Total a receber</p>
        <p className="text-3xl font-semibold tabular-nums text-fg" data-testid="pay-total">
          {formatMoney(totalCents)}
        </p>
      </div>

      <div className="flex flex-wrap gap-2" role="group" aria-label="Valor recebido rápido">
        {suggestions.map((value, index) => (
          <Button
            key={value}
            type="button"
            size="sm"
            variant={tendered === value ? "primary" : "secondary"}
            aria-pressed={tendered === value}
            onClick={() => setTenderedText(index === 0 ? "" : centsToInput(value))}
          >
            {index === 0 ? `Exato (${formatMoney(value)})` : formatMoney(value)}
          </Button>
        ))}
      </div>

      <TextField
        label="Valor recebido (R$)"
        inputMode="decimal"
        autoComplete="off"
        placeholder={centsToInput(totalCents)}
        value={tenderedText}
        onChange={(event) => setTenderedText(event.target.value)}
        error={invalid ? "Informe um valor, por exemplo 50,00." : undefined}
        autoFocus
      />

      <div aria-live="polite" aria-atomic="true" className="rounded-control bg-info-soft px-4 py-3 text-info-soft-fg">
        {change !== null ? (
          <>
            <p className="text-sm font-medium">Troco a devolver</p>
            <p className="text-3xl font-semibold tabular-nums" data-testid="pay-change">
              {formatMoney(change)}
            </p>
            <p className="mt-1 text-sm">
              {change > 0
                ? changeBreakdown(change)
                    .map((part) => `${part.count}× ${formatMoney(part.value)}`)
                    .join(" · ")
                : "Sem troco: o valor recebido é exato."}
            </p>
          </>
        ) : shortfall !== null ? (
          <p className="text-sm font-medium">Faltam {formatMoney(shortfall)} para cobrir a venda.</p>
        ) : (
          <p className="text-sm">Informe o valor recebido.</p>
        )}
      </div>

      <FormError message={error} />
      <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
        <Button type="button" variant="secondary" onClick={onClose} disabled={sending}>
          Voltar
        </Button>
        <Button type="submit" disabled={!canConfirm} loading={sending}>
          Confirmar recebimento
        </Button>
      </div>
    </form>
  );
}
