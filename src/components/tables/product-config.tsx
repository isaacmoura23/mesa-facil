"use client";

import { useId, useMemo, useRef, useState } from "react";
import { ArrowLeft } from "lucide-react";
import { Alert } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { formatCents } from "@/lib/format";
import { cn } from "@/lib/utils/cn";
import { MAX_NOTES, type CartLineInput } from "@/modules/storefront/cart";
import { findVariant, hasVariants, initialVariantId, isOrderable } from "@/modules/storefront/product";
import type { MenuModifierGroup, MenuProduct } from "@/modules/storefront/schemas";
import { OptionRow } from "@/components/storefront/option-row";
import { ProductBadges } from "@/components/storefront/product-badges";
import { QuantityStepper } from "@/components/storefront/quantity-stepper";
import { VariantPicker } from "@/components/storefront/variant-picker";

type Selection = Record<string, string[]>;

function signedCents(cents: number): string {
  if (cents === 0) return "";
  return `${cents > 0 ? "+ " : "- "}${formatCents(Math.abs(cents))}`;
}

function groupHint(group: MenuModifierGroup): string {
  const { minSelections: min, maxSelections: max } = group;
  if (max === 1) return min >= 1 ? "Escolha 1 opção" : "Escolha até 1 opção";
  if (max === null) return min > 0 ? `Escolha pelo menos ${min}` : "Escolha quantas quiser";
  if (min === 0) return `Escolha até ${max}`;
  if (min === max) return `Escolha ${max}`;
  return `Escolha de ${min} a ${max}`;
}

function groupError(group: MenuModifierGroup, selected: string[]): string | null {
  const available = group.modifiers.filter((m) => m.isAvailable).length;
  if (group.minSelections > available) return "Este grupo está sem opções disponíveis no momento.";
  if (selected.length < group.minSelections) {
    return group.minSelections === 1
      ? "Escolha uma opção para continuar."
      : `Escolha pelo menos ${group.minSelections} opções para continuar.`;
  }
  return null;
}

type ProductConfigProps = {
  product: MenuProduct;
  onBack: () => void;
  onAdd: (line: CartLineInput) => void;
};

/** Configura um item (tamanho obrigatório, adicionais com mín./máx., quantidade, observação). */
export function ProductConfig({ product, onBack, onAdd }: ProductConfigProps) {
  const uid = useId();
  const sized = hasVariants(product);
  const orderable = isOrderable(product);
  const [variantId, setVariantId] = useState(() => initialVariantId(product));
  const [selection, setSelection] = useState<Selection>({});
  const [quantity, setQuantity] = useState(1);
  const [notes, setNotes] = useState("");
  const [submitted, setSubmitted] = useState(false);
  const groupRefs = useRef(new Map<string, HTMLFieldSetElement>());
  const variantRef = useRef<HTMLFieldSetElement>(null);

  const selectedModifiers = useMemo(
    () =>
      product.modifierGroups.flatMap((group) =>
        group.modifiers.filter((m) => (selection[group.id] ?? []).includes(m.id)),
      ),
    [product.modifierGroups, selection],
  );
  const variant = sized ? findVariant(product, variantId) : null;
  const needsVariant = sized && !variant;
  const baseCents = variant ? variant.priceCents : product.priceCents;
  const unitCents = Math.max(0, baseCents + selectedModifiers.reduce((sum, m) => sum + m.priceDeltaCents, 0));

  const errors = useMemo(() => {
    const out = new Map<string, string>();
    for (const group of product.modifierGroups) {
      const error = groupError(group, selection[group.id] ?? []);
      if (error) out.set(group.id, error);
    }
    return out;
  }, [product.modifierGroups, selection]);

  function toggle(group: MenuModifierGroup, modifierId: string, checked: boolean) {
    setSelection((current) => {
      const now = current[group.id] ?? [];
      if (group.maxSelections === 1) return { ...current, [group.id]: checked ? [modifierId] : [] };
      const next = checked ? [...now, modifierId] : now.filter((id) => id !== modifierId);
      if (group.maxSelections !== null && next.length > group.maxSelections) return current;
      return { ...current, [group.id]: next };
    });
  }

  function submit() {
    if (!orderable) return;
    setSubmitted(true);
    if (needsVariant) {
      variantRef.current?.focus();
      return;
    }
    if (errors.size > 0) {
      const firstId = product.modifierGroups.find((g) => errors.has(g.id))?.id;
      groupRefs.current.get(firstId ?? "")?.focus();
      return;
    }
    onAdd({
      productId: product.id,
      variantId: variant ? variant.id : null,
      quantity,
      modifierIds: selectedModifiers.map((m) => m.id),
      notes: notes.trim(),
      snapshot: {
        name: product.name,
        variantName: variant ? variant.name : null,
        unitPriceCents: baseCents,
        imagePath: product.imagePath,
        modifiers: selectedModifiers.map((m) => ({ id: m.id, name: m.name, priceDeltaCents: m.priceDeltaCents })),
      },
    });
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex-1 overflow-y-auto px-5 py-4">
        <button
          type="button"
          onClick={onBack}
          className="-ml-2 inline-flex h-11 items-center gap-2 rounded-control px-2 text-sm font-medium text-muted hover:text-fg"
        >
          <ArrowLeft aria-hidden="true" className="size-4" />
          Voltar ao cardápio
        </button>

        <h3 className="mt-1 text-xl font-semibold text-fg">{product.name}</h3>
        <ProductBadges badges={product.badges} className="mt-2 flex flex-wrap gap-1.5" />
        {product.description ? <p className="mt-2 text-sm leading-relaxed text-muted">{product.description}</p> : null}
        <p className="mt-2 text-lg font-semibold tabular-nums text-fg" aria-live="polite">
          {needsVariant ? (
            <>
              <span className="mr-1 text-sm font-normal text-muted">a partir de</span>
              {formatCents(product.priceCents)}
            </>
          ) : (
            formatCents(unitCents)
          )}
        </p>

        {!orderable ? (
          <Alert tone="warning" className="mt-4" title="Item indisponível">
            Este item não está disponível agora e não pode ser lançado.
          </Alert>
        ) : null}

        {sized ? (
          <div className="mt-5">
            <VariantPicker
              uid={uid}
              variants={product.variants}
              value={variantId}
              onChange={setVariantId}
              disabled={!orderable}
              error={submitted && needsVariant ? "Escolha um tamanho para continuar." : undefined}
              fieldsetRef={variantRef}
            />
          </div>
        ) : null}

        {product.modifierGroups.length > 0 ? (
          <div className="mt-5 space-y-5">
            {product.modifierGroups.map((group) => {
              const selected = selection[group.id] ?? [];
              const error = submitted ? errors.get(group.id) : undefined;
              const single = group.maxSelections === 1;
              const full = group.maxSelections !== null && !single && selected.length >= group.maxSelections;
              const errorId = `${uid}-${group.id}-erro`;
              return (
                <fieldset
                  key={group.id}
                  ref={(node) => {
                    if (node) groupRefs.current.set(group.id, node);
                    else groupRefs.current.delete(group.id);
                  }}
                  tabIndex={-1}
                  aria-describedby={error ? errorId : undefined}
                  disabled={!orderable}
                  className="min-w-0 rounded-card border border-line bg-surface p-4 focus:outline-none focus-visible:outline-2 focus-visible:outline-ring"
                >
                  <legend className="float-left flex w-full flex-wrap items-center gap-x-2 gap-y-1 px-1 text-base font-semibold text-fg">
                    {group.name}
                    {group.minSelections > 0 ? <Badge tone="info">Obrigatório</Badge> : null}
                  </legend>
                  <p className="clear-both mb-3 pt-1 text-sm text-muted">{groupHint(group)}</p>
                  <div className="space-y-2">
                    {single && group.minSelections === 0 ? (
                      <OptionRow
                        type="radio"
                        name={`${uid}-${group.id}`}
                        checked={selected.length === 0}
                        onChange={() => toggle(group, "", false)}
                        label="Nenhum"
                      />
                    ) : null}
                    {group.modifiers.map((modifier) => {
                      const checked = selected.includes(modifier.id);
                      return (
                        <OptionRow
                          key={modifier.id}
                          type={single ? "radio" : "checkbox"}
                          name={`${uid}-${group.id}`}
                          checked={checked}
                          disabled={!modifier.isAvailable || (!single && full && !checked)}
                          onChange={(next) => toggle(group, modifier.id, next)}
                          label={modifier.name}
                          extra={modifier.isAvailable ? signedCents(modifier.priceDeltaCents) : "Indisponível"}
                        />
                      );
                    })}
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
            })}
          </div>
        ) : null}

        <div className="mt-5">
          <label htmlFor={`${uid}-obs`} className="text-sm font-medium text-fg">
            Observações do item
          </label>
          <textarea
            id={`${uid}-obs`}
            value={notes}
            onChange={(event) => setNotes(event.target.value.slice(0, MAX_NOTES))}
            maxLength={MAX_NOTES}
            rows={2}
            placeholder="Ex.: sem cebola, ponto da carne"
            disabled={!orderable}
            className="mt-2 block w-full resize-y rounded-control border border-line bg-surface px-3 py-2.5 text-base text-fg hover:border-line-strong disabled:opacity-60 sm:text-sm"
          />
        </div>
      </div>

      <div className="flex items-center gap-3 border-t border-line bg-surface px-5 py-3">
        <QuantityStepper value={quantity} onChange={(next) => setQuantity(Math.min(99, Math.max(1, next)))} label={product.name} />
        <Button size="lg" className="min-w-0 flex-1 justify-between" onClick={submit} disabled={!orderable}>
          <span>Adicionar ao pedido</span>
          <span className="tabular-nums">{needsVariant ? "-" : formatCents(unitCents * quantity)}</span>
        </Button>
      </div>
    </div>
  );
}
