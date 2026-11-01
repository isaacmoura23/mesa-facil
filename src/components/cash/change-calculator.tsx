"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { TextField } from "@/components/ui/input";
import { formatMoney } from "@/modules/operations/format";
import { changeBreakdown, changeFor, shortfallFor, tenderSuggestions } from "@/modules/cash/money";
import { centsToInput, parseMoneyToCents } from "@/modules/tab-billing/money";

/**
 * Calculadora de troco avulsa (não grava nada): valor da conta + valor recebido = troco, com a
 * quebra em notas e moedas. O mesmo cálculo está na tela de pagamento de pedidos e comandas.
 */
export function ChangeCalculator({ onClose }: { onClose: () => void }) {
  const [dueText, setDueText] = useState("");
  const [tenderedText, setTenderedText] = useState("");
  const due = dueText.trim() ? parseMoneyToCents(dueText) : null;
  const tendered = tenderedText.trim() ? parseMoneyToCents(tenderedText) : null;
  const change = changeFor(due, tendered);
  const shortfall = shortfallFor(due, tendered);
  const suggestions = due !== null && due > 0 ? tenderSuggestions(due) : [];

  return (
    <div className="flex flex-col gap-4">
      <TextField
        label="Valor da conta (R$)"
        inputMode="decimal"
        autoComplete="off"
        value={dueText}
        onChange={(event) => setDueText(event.target.value)}
        error={dueText.trim() && due === null ? "Informe um valor, por exemplo 37,90." : undefined}
        autoFocus
      />
      {suggestions.length > 0 ? (
        <div className="flex flex-wrap gap-2" role="group" aria-label="Valor recebido rápido">
          {suggestions.map((value, index) => (
            <Button
              key={value}
              size="sm"
              variant={tendered === value ? "primary" : "secondary"}
              aria-pressed={tendered === value}
              onClick={() => setTenderedText(centsToInput(value))}
            >
              {index === 0 ? `Exato (${formatMoney(value)})` : formatMoney(value)}
            </Button>
          ))}
        </div>
      ) : null}
      <TextField
        label="Valor recebido (R$)"
        inputMode="decimal"
        autoComplete="off"
        value={tenderedText}
        onChange={(event) => setTenderedText(event.target.value)}
        error={tenderedText.trim() && tendered === null ? "Informe um valor, por exemplo 50,00." : undefined}
      />
      <div aria-live="polite" aria-atomic="true" className="rounded-control bg-info-soft px-4 py-3 text-info-soft-fg">
        {change !== null ? (
          <>
            <p className="text-sm font-medium">Troco a devolver</p>
            <p className="text-3xl font-semibold tabular-nums" data-testid="calc-change">
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
          <p className="text-sm font-medium">Faltam {formatMoney(shortfall)} para cobrir a conta.</p>
        ) : (
          <p className="text-sm">Informe o valor da conta e o valor recebido.</p>
        )}
      </div>
      <div className="flex justify-end gap-2">
        <Button
          variant="secondary"
          onClick={() => {
            setDueText("");
            setTenderedText("");
          }}
        >
          Limpar
        </Button>
        <Button onClick={onClose}>Fechar</Button>
      </div>
    </div>
  );
}
