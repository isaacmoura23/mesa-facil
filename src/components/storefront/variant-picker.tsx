import type { Ref } from "react";
import { Badge } from "@/components/ui/badge";
import { formatCents } from "@/lib/format";
import { cn } from "@/lib/utils/cn";
import type { MenuVariant } from "@/modules/storefront/schemas";
import { OptionRow } from "./option-row";

type VariantPickerProps = {
  /** Prefixo único para ids/nomes (useId do pai). */
  uid: string;
  variants: MenuVariant[];
  value: string;
  onChange: (variantId: string) => void;
  disabled?: boolean;
  /** Mensagem de erro (obrigatório e sem escolha). */
  error?: string;
  fieldsetRef?: Ref<HTMLFieldSetElement>;
};

/**
 * Seletor OBRIGATÓRIO de tamanho (radios nativos num radiogroup). Cada opção
 * mostra o preço; indisponíveis ficam desabilitadas. As setas do teclado
 * navegam entre as opções (comportamento nativo de radios com o mesmo name).
 */
export function VariantPicker({
  uid,
  variants,
  value,
  onChange,
  disabled,
  error,
  fieldsetRef,
}: VariantPickerProps) {
  const errorId = `${uid}-tamanho-erro`;
  return (
    <fieldset
      ref={fieldsetRef}
      role="radiogroup"
      tabIndex={-1}
      aria-required="true"
      aria-invalid={error ? true : undefined}
      aria-describedby={error ? errorId : undefined}
      disabled={disabled}
      className="min-w-0 rounded-card border border-line bg-surface p-4 focus:outline-none focus-visible:outline-2 focus-visible:outline-ring"
    >
      <legend className="float-left flex w-full flex-wrap items-center gap-x-2 gap-y-1 px-1 text-base font-semibold text-fg">
        Tamanho
        <Badge tone="info">Obrigatório</Badge>
      </legend>
      <p className="clear-both mb-3 pt-1 text-sm text-muted">Escolha 1 opção</p>

      <div className="space-y-2">
        {variants.map((variant) => (
          <OptionRow
            key={variant.id}
            type="radio"
            name={`${uid}-tamanho`}
            value={variant.id}
            checked={value === variant.id}
            disabled={!variant.isAvailable}
            onChange={() => onChange(variant.id)}
            label={variant.name}
            extra={variant.isAvailable ? formatCents(variant.priceCents) : "Indisponível"}
          />
        ))}
      </div>

      <p
        id={errorId}
        role={error ? "alert" : undefined}
        className={cn("mt-3 text-sm font-medium text-danger", !error && "hidden")}
      >
        {error}
      </p>
    </fieldset>
  );
}
