"use client";

import { Minus, Plus } from "lucide-react";
import { MAX_QUANTITY } from "@/modules/storefront/cart";
import { cn } from "@/lib/utils/cn";

type QuantityStepperProps = {
  value: number;
  onChange: (next: number) => void;
  /** Nome do item, usado nos rótulos de acessibilidade. */
  label: string;
  /** Quando true, o botão "-" no valor 1 pede para remover (rótulo diferente). */
  removeAtOne?: boolean;
  min?: number;
  size?: "sm" | "md";
  className?: string;
};

/** Controle de quantidade 1 a 99 com botões grandes o bastante para toque. */
export function QuantityStepper({
  value,
  onChange,
  label,
  removeAtOne = false,
  min = 1,
  size = "md",
  className,
}: QuantityStepperProps) {
  const btn = cn(
    "flex items-center justify-center rounded-control text-fg transition-colors hover:bg-surface-2 disabled:pointer-events-none disabled:opacity-40",
    size === "md" ? "size-11" : "size-9",
  );
  return (
    <div
      role="group"
      aria-label={`Quantidade de ${label}`}
      className={cn(
        "inline-flex items-center rounded-control border border-line-strong bg-surface",
        className,
      )}
    >
      <button
        type="button"
        className={btn}
        onClick={() => onChange(value - 1)}
        disabled={!removeAtOne && value <= min}
        aria-label={value <= min && removeAtOne ? `Remover ${label}` : `Diminuir quantidade de ${label}`}
      >
        <Minus aria-hidden="true" className="size-4" />
      </button>
      <span
        className={cn(
          "min-w-8 text-center text-sm font-semibold tabular-nums",
          size === "sm" && "min-w-6",
        )}
        aria-live="polite"
        aria-atomic="true"
      >
        {value}
      </span>
      <button
        type="button"
        className={btn}
        onClick={() => onChange(value + 1)}
        disabled={value >= MAX_QUANTITY}
        aria-label={`Aumentar quantidade de ${label}`}
      >
        <Plus aria-hidden="true" className="size-4" />
      </button>
    </div>
  );
}
