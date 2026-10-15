"use client";

import { Banknote, CreditCard, QrCode, type LucideIcon } from "lucide-react";
import { Alert } from "@/components/ui/alert";
import { TextField } from "@/components/ui/input";
import { cn } from "@/lib/utils/cn";
import {
  PAYMENT_METHODS,
  PAYMENT_METHOD_LABELS,
  type PaymentMethod,
} from "@/modules/orders-server/schemas";
import { PAYMENT_HINTS, type PaymentFieldErrors } from "@/modules/storefront/order-checkout";
import type { Fulfillment } from "@/modules/storefront/schemas";

const ICONS: Record<PaymentMethod, LucideIcon> = {
  CASH: Banknote,
  PIX: QrCode,
  CARD: CreditCard,
};

const WHEN: Record<Fulfillment, string> = {
  DELIVERY: "na entrega",
  PICKUP: "na retirada",
  DINE_IN: "no restaurante",
};

type PaymentSectionProps = {
  id: string;
  fulfillment: Fulfillment;
  method: PaymentMethod | "";
  changeFor: string;
  errors: PaymentFieldErrors;
  onMethod: (method: PaymentMethod) => void;
  onChangeFor: (value: string) => void;
};

/**
 * Forma de pagamento DECLARADA. Não existe pagamento online: o cliente só diz
 * como vai pagar ao receber/retirar, e o restaurante cobra no momento.
 */
export function PaymentSection({
  id,
  fulfillment,
  method,
  changeFor,
  errors,
  onMethod,
  onChangeFor,
}: PaymentSectionProps) {
  const errorId = `${id}-payment-error`;
  return (
    <section className="rounded-card border border-line bg-surface p-4 shadow-card sm:p-6">
      <h2 className="mb-1 text-base font-semibold text-fg">Como você vai pagar?</h2>
      <p className="mb-4 text-sm text-muted">
        O pagamento é feito {WHEN[fulfillment]}. Não cobramos nada online.
      </p>
      <fieldset aria-describedby={errors.method ? errorId : undefined}>
        <legend className="sr-only">Forma de pagamento</legend>
        <div className="grid gap-3 sm:grid-cols-3">
          {PAYMENT_METHODS.map((option) => {
            const Icon = ICONS[option];
            const checked = method === option;
            return (
              <label
                key={option}
                className={cn(
                  "flex min-h-14 cursor-pointer flex-col items-start gap-1.5 rounded-control border px-4 py-3 transition-colors",
                  checked ? "border-accent bg-accent-soft" : "border-line hover:border-line-strong",
                )}
              >
                <span className="flex items-center gap-3">
                  <input
                    id={`${id}-payment-${option}`}
                    type="radio"
                    name={`${id}-payment`}
                    value={option}
                    checked={checked}
                    onChange={() => onMethod(option)}
                    className="size-5 shrink-0 accent-[var(--accent)]"
                  />
                  <Icon aria-hidden="true" className="size-5 shrink-0 text-muted" />
                  <span className="text-sm font-semibold text-fg">{PAYMENT_METHOD_LABELS[option]}</span>
                </span>
                <span className="text-sm text-muted">{PAYMENT_HINTS[option]}</span>
              </label>
            );
          })}
        </div>
      </fieldset>
      {errors.method ? (
        <p id={errorId} className="mt-2 text-sm font-medium text-danger">
          {errors.method}
        </p>
      ) : null}

      {method === "CASH" ? (
        <div className="mt-4">
          <TextField
            id={`${id}-changeFor`}
            label="Precisa de troco? Vai pagar com quanto? (opcional)"
            inputMode="decimal"
            placeholder="Ex.: 100,00"
            maxLength={20}
            value={changeFor}
            onChange={(e) => onChangeFor(e.target.value)}
            error={errors.changeFor}
          />
        </div>
      ) : null}

      {method === "PIX" ? (
        <Alert tone="info" className="mt-4">
          Você paga por Pix {WHEN[fulfillment]}; o restaurante informa a chave na hora.
        </Alert>
      ) : null}
    </section>
  );
}
