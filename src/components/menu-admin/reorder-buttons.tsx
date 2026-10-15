"use client";

import { ChevronDown, ChevronUp } from "lucide-react";
import { cn } from "@/lib/utils/cn";

type ReorderButtonsProps = {
  /** Nome do item, usado nos rótulos de acessibilidade. */
  name: string;
  canMoveUp: boolean;
  canMoveDown: boolean;
  /** Desabilita tudo (ex.: gravando ou com filtro ativo). */
  disabled?: boolean;
  onMove: (direction: -1 | 1) => void;
  className?: string;
};

const buttonClass =
  "inline-flex size-10 items-center justify-center rounded-control text-muted transition-colors hover:bg-surface-2 hover:text-fg disabled:pointer-events-none disabled:opacity-35 sm:size-9";

export function ReorderButtons({ name, canMoveUp, canMoveDown, disabled, onMove, className }: ReorderButtonsProps) {
  return (
    <div role="group" aria-label={`Ordem de ${name}`} className={cn("inline-flex items-center", className)}>
      <button
        type="button"
        className={buttonClass}
        disabled={disabled || !canMoveUp}
        onClick={() => onMove(-1)}
        aria-label={`Mover ${name} para cima`}
      >
        <ChevronUp aria-hidden="true" className="size-5" />
      </button>
      <button
        type="button"
        className={buttonClass}
        disabled={disabled || !canMoveDown}
        onClick={() => onMove(1)}
        aria-label={`Mover ${name} para baixo`}
      >
        <ChevronDown aria-hidden="true" className="size-5" />
      </button>
    </div>
  );
}
