"use client";

import { useRef, useState, type FormEvent } from "react";
import { Banknote } from "lucide-react";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { TextField } from "@/components/ui/input";
import { Segmented } from "@/components/printing/segmented";
import { formatMoney } from "@/modules/operations/format";
import type { AppSupabaseClient } from "@/lib/supabase/types";
import { BillingActionError } from "@/modules/tab-billing/errors";
import { centsToInput, parseMoneyToCents } from "@/modules/tab-billing/money";
import { recordPayment } from "@/modules/tab-billing/rpc";
import { PAYMENT_METHODS, PAYMENT_METHOD_LABELS, type PaymentMethod } from "@/modules/tab-billing/types";

type PaymentFormProps = {
  supabase: AppSupabaseClient;
  tabId: string;
  remainingCents: number;
  /** Relê o saldo e avisa o chamador quando o estado mudou por outro caminho (ex.: OVERPAYMENT). */
  onStale: () => Promise<void>;
  /** Pagamento gravado: o painel guarda o aviso (troco!) mesmo que a conta fique quitada e o formulário suma. */
  onRecorded: (message: string) => Promise<void>;
  /** Nova tentativa: o painel limpa o aviso do pagamento anterior. */
  onAttempt: () => void;
};

type Feedback = { text: string } | null;

const METHOD_OPTIONS = PAYMENT_METHODS.map((value) => ({ value, label: PAYMENT_METHOD_LABELS[value] }));

/** Chave da tentativa: mesma combinação de dados reaproveita a chave (retry seguro), dados novos geram outra. */
function newAttemptKey(): string {
  return globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

export function PaymentForm({ supabase, tabId, remainingCents, onStale, onRecorded, onAttempt }: PaymentFormProps) {
  const [method, setMethod] = useState<PaymentMethod>("PIX");
  // null = acompanha o saldo atual (padrão = saldo restante).
  const [amountText, setAmountText] = useState<string | null>(null);
  const [tenderedText, setTenderedText] = useState("");
  const [reference, setReference] = useState("");
  const [pending, setPending] = useState(false);
  const [feedback, setFeedback] = useState<Feedback>(null);
  const lockRef = useRef(false);
  const attemptRef = useRef<{ signature: string; key: string } | null>(null);

  const shownAmount = amountText ?? centsToInput(remainingCents);
  const amountCents = parseMoneyToCents(shownAmount);
  const isCash = method === "CASH";
  const tenderedCents = isCash && tenderedText.trim() ? parseMoneyToCents(tenderedText) : null;

  const amountError =
    amountCents === null || amountCents <= 0
      ? "Informe um valor maior que zero, por exemplo 25,90."
      : amountCents > remainingCents
        ? `O valor não pode passar do saldo restante (${formatMoney(remainingCents)}).`
        : undefined;
  const tenderedError =
    isCash && tenderedText.trim()
      ? tenderedCents === null
        ? "Informe o valor recebido, por exemplo 50,00."
        : amountCents !== null && tenderedCents < amountCents
          ? "O valor recebido não pode ser menor que o valor do pagamento."
          : undefined
      : undefined;
  const change =
    isCash && tenderedCents !== null && amountCents !== null && !amountError && !tenderedError
      ? tenderedCents - amountCents
      : null;
  const canSubmit = !pending && !amountError && !tenderedError && amountCents !== null;

  function clearFeedback() {
    setFeedback(null);
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (lockRef.current || !canSubmit || amountCents === null) return;
    lockRef.current = true;
    setPending(true);
    setFeedback(null);
    onAttempt();

    const typedReference = reference.trim();
    const signature = [method, amountCents, tenderedCents ?? "", typedReference].join("|");
    if (attemptRef.current?.signature !== signature) {
      attemptRef.current = { signature, key: newAttemptKey() };
    }
    const key = attemptRef.current.key;
    const sentReference = typedReference ? `${typedReference}#${key.slice(0, 8)}` : `ui-${key}`;

    try {
      const result = await recordPayment(supabase, {
        tabId,
        method,
        amountCents,
        tenderedCents,
        reference: sentReference,
      });
      attemptRef.current = null;
      const changeCents = result.change_cents ?? (method === "CASH" && tenderedCents !== null ? tenderedCents - amountCents : 0);
      const notice =
        `Pagamento de ${formatMoney(amountCents)} em ${PAYMENT_METHOD_LABELS[method].toLowerCase()} registrado.` +
        (changeCents > 0 ? ` Troco a devolver: ${formatMoney(changeCents)}.` : "");
      setAmountText(null);
      setTenderedText("");
      setReference("");
      await onRecorded(notice);
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : "Não foi possível registrar o pagamento.";
      setFeedback({ text: message });
      if (cause instanceof BillingActionError && cause.stale) {
        attemptRef.current = null;
        setAmountText(null);
        await onStale();
      }
    } finally {
      lockRef.current = false;
      setPending(false);
    }
  }

  return (
    <form onSubmit={(event) => void handleSubmit(event)} noValidate className="flex flex-col gap-4" aria-label="Registrar pagamento">
      <Segmented
        legend="Forma de pagamento"
        value={method}
        options={METHOD_OPTIONS}
        onChange={(next) => {
          setMethod(next);
          clearFeedback();
        }}
        disabled={pending}
      />

      <div className="grid gap-4 sm:grid-cols-2">
        <div className="flex flex-col gap-2">
          <TextField
            label="Valor (R$)"
            hint="Padrão: o saldo restante."
            inputMode="decimal"
            autoComplete="off"
            value={shownAmount}
            onChange={(event) => {
              setAmountText(event.target.value);
              clearFeedback();
            }}
            error={amountError}
            disabled={pending}
          />
          <div>
            <Button
              variant="secondary"
              size="sm"
              onClick={() => setAmountText(null)}
              disabled={pending || amountText === null}
            >
              Saldo total ({formatMoney(remainingCents)})
            </Button>
          </div>
        </div>

        {isCash ? (
          <TextField
            label="Valor recebido (R$)"
            hint="Opcional. Informe para calcular o troco."
            inputMode="decimal"
            autoComplete="off"
            value={tenderedText}
            onChange={(event) => {
              setTenderedText(event.target.value);
              clearFeedback();
            }}
            error={tenderedError}
            disabled={pending}
          />
        ) : (
          <TextField
            label="Referência"
            hint="Opcional. Ex.: final do cartão ou código do Pix."
            maxLength={60}
            autoComplete="off"
            value={reference}
            onChange={(event) => setReference(event.target.value)}
            disabled={pending}
          />
        )}
      </div>

      {isCash ? (
        <TextField
          label="Referência"
          hint="Opcional."
          maxLength={60}
          autoComplete="off"
          value={reference}
          onChange={(event) => setReference(event.target.value)}
          disabled={pending}
        />
      ) : null}

      <div aria-live="polite" aria-atomic="true" className="empty:hidden">
        {change !== null ? (
          <p className="rounded-control bg-info-soft px-3 py-2 text-sm font-medium text-info-soft-fg">
            Troco a devolver: <span className="tabular-nums">{formatMoney(change)}</span>
          </p>
        ) : null}
      </div>

      {feedback ? <Alert tone="danger">{feedback.text}</Alert> : null}

      <Button type="submit" size="lg" loading={pending} disabled={!canSubmit} className="sm:self-start">
        <Banknote aria-hidden="true" className="size-4" />
        {amountCents !== null && !amountError ? `Registrar ${formatMoney(amountCents)}` : "Registrar pagamento"}
      </Button>
    </form>
  );
}
