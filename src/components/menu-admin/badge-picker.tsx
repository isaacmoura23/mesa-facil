"use client";

import { Check } from "lucide-react";
import { cn } from "@/lib/utils/cn";
import { BADGE_LABELS, MAX_BADGES, PRODUCT_BADGES, type ProductBadge } from "@/modules/menu/badges";

type BadgePickerProps = {
  value: ProductBadge[];
  onChange: (next: ProductBadge[]) => void;
  error?: string;
  disabled?: boolean;
};

/** Seleção múltipla de selos (até 4), em chips com caixa de seleção nativa. */
export function BadgePicker({ value, onChange, error, disabled = false }: BadgePickerProps) {
  const full = value.length >= MAX_BADGES;

  function toggle(badge: ProductBadge, checked: boolean) {
    if (checked) {
      if (!value.includes(badge) && !full) onChange([...value, badge]);
    } else {
      onChange(value.filter((item) => item !== badge));
    }
  }

  return (
    <fieldset className="rounded-control border border-line p-3" disabled={disabled}>
      <legend className="px-1 text-sm font-medium text-fg">Selos (opcional)</legend>
      <p className="mb-3 text-sm text-muted">
        Destaques exibidos junto ao produto no cardápio. Escolha até {MAX_BADGES}.
      </p>
      <div className="flex flex-wrap gap-2">
        {PRODUCT_BADGES.map((badge) => {
          const checked = value.includes(badge);
          const blocked = !checked && full;
          return (
            <label
              key={badge}
              className={cn(
                "inline-flex min-h-11 cursor-pointer items-center gap-1.5 rounded-full border px-3.5 text-sm font-medium transition-colors",
                "has-[input:focus-visible]:outline-2 has-[input:focus-visible]:outline-offset-2 has-[input:focus-visible]:outline-accent",
                checked
                  ? "border-transparent bg-accent-soft text-accent-soft-fg"
                  : "border-line-strong bg-surface text-fg hover:bg-surface-2",
                blocked && "cursor-not-allowed opacity-50 hover:bg-surface",
              )}
            >
              <input
                type="checkbox"
                checked={checked}
                disabled={blocked}
                onChange={(event) => toggle(badge, event.target.checked)}
                className="sr-only"
              />
              {checked ? <Check aria-hidden="true" className="size-4" /> : null}
              {BADGE_LABELS[badge]}
            </label>
          );
        })}
      </div>
      <p className="mt-2 text-xs text-muted" aria-live="polite">
        {value.length} de {MAX_BADGES} selecionados
        {full ? ". Desmarque um selo para escolher outro." : ""}
      </p>
      {error ? (
        <p role="alert" className="mt-2 text-sm font-medium text-danger">
          {error}
        </p>
      ) : null}
    </fieldset>
  );
}
