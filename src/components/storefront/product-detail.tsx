"use client";

import { useId, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import { Alert } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { useToast } from "@/components/ui/toast";
import { formatCents } from "@/lib/format";
import { cn } from "@/lib/utils/cn";
import { MAX_NOTES } from "@/modules/storefront/cart";
import { useCart } from "@/modules/storefront/cart-context";
import { findVariant, hasVariants, initialVariantId, isOrderable } from "@/modules/storefront/product";
import type { MenuModifierGroup, MenuProduct } from "@/modules/storefront/schemas";
import { OptionRow } from "./option-row";
import { ProductBadges } from "./product-badges";
import { ProductImage, hasProductImage } from "./product-image";
import { QuantityStepper } from "./quantity-stepper";
import { VariantPicker } from "./variant-picker";

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

/** Retorna a mensagem de erro de um grupo (ou null se estiver válido). */
function groupError(group: MenuModifierGroup, selected: string[]): string | null {
  const available = group.modifiers.filter((m) => m.isAvailable).length;
  if (group.minSelections > available) {
    return "Este grupo está sem opções disponíveis no momento.";
  }
  if (selected.length < group.minSelections) {
    return group.minSelections === 1
      ? "Escolha uma opção para continuar."
      : `Escolha pelo menos ${group.minSelections} opções para continuar.`;
  }
  return null;
}

type ProductDetailProps = { slug: string; product: MenuProduct };

export function ProductDetail({ slug, product }: ProductDetailProps) {
  const router = useRouter();
  const { addLine } = useCart();
  const { toast } = useToast();
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

  const menuHref = `/r/${encodeURIComponent(slug)}`;

  const selectedModifiers = useMemo(
    () =>
      product.modifierGroups.flatMap((group) =>
        group.modifiers.filter((m) => (selection[group.id] ?? []).includes(m.id)),
      ),
    [product.modifierGroups, selection],
  );
  const variant = sized ? findVariant(product, variantId) : null;
  // Com tamanhos, o preço só existe depois de escolher um (senão: "a partir de").
  const needsVariant = sized && !variant;
  const baseCents = variant ? variant.priceCents : product.priceCents;
  const unitCents = Math.max(
    0,
    baseCents + selectedModifiers.reduce((sum, m) => sum + m.priceDeltaCents, 0),
  );
  const totalCents = unitCents * quantity;
  const variantError = needsVariant ? "Escolha um tamanho para continuar." : null;

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
    if (variantError) {
      variantRef.current?.focus();
      return;
    }
    if (errors.size > 0) {
      const firstId = product.modifierGroups.find((g) => errors.has(g.id))?.id;
      groupRefs.current.get(firstId ?? "")?.focus();
      return;
    }
    addLine({
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
        modifiers: selectedModifiers.map((m) => ({
          id: m.id,
          name: m.name,
          priceDeltaCents: m.priceDeltaCents,
        })),
      },
    });
    toast({
      title: "Adicionado ao carrinho",
      description: `${quantity}x ${product.name}${variant ? ` (${variant.name})` : ""}`,
      tone: "success",
      duration: 3000,
    });
    router.push(menuHref);
  }

  const image = hasProductImage(product.imagePath);

  return (
    <div className="mx-auto max-w-2xl">
      <Link
        href={menuHref}
        className="-ml-2 inline-flex h-11 items-center gap-2 rounded-control px-2 text-sm font-medium text-muted hover:text-fg"
      >
        <ArrowLeft aria-hidden="true" className="size-4" />
        Voltar ao cardápio
      </Link>

      {image ? (
        <div className="relative mt-2 aspect-[16/10] w-full overflow-hidden rounded-card bg-surface-2">
          <ProductImage
            path={product.imagePath}
            alt={product.name}
            sizes="(min-width: 672px) 672px, 100vw"
            priority
          />
        </div>
      ) : null}

      <div className={cn(image ? "mt-5" : "mt-2")}>
        <h1 className="text-2xl font-semibold tracking-tight text-fg">{product.name}</h1>
        <ProductBadges badges={product.badges} className="mt-2 flex flex-wrap gap-1.5" />
        <p className="mt-2 text-lg font-semibold tabular-nums text-fg" aria-live="polite" aria-atomic="true">
          {needsVariant ? (
            <>
              <span className="mr-1 text-sm font-normal text-muted">a partir de</span>
              {formatCents(product.priceCents)}
            </>
          ) : (
            <>
              <span className="sr-only">Preço do item: </span>
              {formatCents(unitCents)}
            </>
          )}
        </p>
        {!needsVariant && (sized || selectedModifiers.length > 0) ? (
          <p className="text-sm text-muted">
            {[variant ? `Tamanho ${variant.name}` : null, selectedModifiers.length > 0 ? "com adicionais" : null]
              .filter(Boolean)
              .join(", ")}
          </p>
        ) : null}
        {product.description ? (
          <p className="mt-3 whitespace-pre-line text-sm leading-relaxed text-muted">
            {product.description}
          </p>
        ) : null}
      </div>

      {!orderable ? (
        <Alert tone="warning" className="mt-5" title="Item indisponível">
          Este item não está disponível agora, por isso não pode ser adicionado ao carrinho.
        </Alert>
      ) : null}

      {sized ? (
        <div className="mt-6">
          <VariantPicker
            uid={uid}
            variants={product.variants}
            value={variantId}
            onChange={setVariantId}
            disabled={!orderable}
            error={submitted && variantError ? variantError : undefined}
            fieldsetRef={variantRef}
          />
        </div>
      ) : null}

      {product.modifierGroups.length > 0 ? (
        <div className="mt-6 space-y-6">
          {product.modifierGroups.map((group) => {
            const selected = selection[group.id] ?? [];
            const error = submitted ? errors.get(group.id) : undefined;
            const single = group.maxSelections === 1;
            const full =
              group.maxSelections !== null && !single && selected.length >= group.maxSelections;
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
                        extra={
                          modifier.isAvailable
                            ? signedCents(modifier.priceDeltaCents)
                            : "Indisponível"
                        }
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

      <div className="mt-6">
        <label htmlFor={`${uid}-obs`} className="text-sm font-medium text-fg">
          Observações
        </label>
        <p className="mt-1 text-sm text-muted">Ex.: sem cebola, ponto da carne.</p>
        <textarea
          id={`${uid}-obs`}
          value={notes}
          onChange={(event) => setNotes(event.target.value.slice(0, MAX_NOTES))}
          maxLength={MAX_NOTES}
          rows={3}
          disabled={!orderable}
          className="mt-2 block w-full resize-y rounded-control border border-line bg-surface px-3 py-2.5 text-base text-fg hover:border-line-strong disabled:opacity-60 sm:text-sm"
        />
        <p className="mt-1 text-right text-xs text-muted" aria-hidden="true">
          {notes.length}/{MAX_NOTES}
        </p>
      </div>

      <div className="fixed inset-x-0 bottom-0 z-30 border-t border-line bg-surface px-3 sm:px-4 pb-[max(0.75rem,env(safe-area-inset-bottom))] pt-3 lg:static lg:mt-6 lg:border-0 lg:bg-transparent lg:p-0">
        <div className="mx-auto flex max-w-2xl items-center gap-2 sm:gap-3">
          <QuantityStepper
            value={quantity}
            onChange={(next) => setQuantity(Math.min(99, Math.max(1, next)))}
            label={product.name}
          />
          <Button
            size="lg"
            className="min-w-0 flex-1 justify-between px-3"
            onClick={submit}
            disabled={!orderable}
          >
            <span className="max-[399px]:sr-only">Adicionar ao carrinho</span>
            <span aria-hidden="true" className="min-[400px]:hidden">Adicionar</span>
            <span className="tabular-nums" aria-live="polite">
              <span className="sr-only">Total estimado: </span>
              {needsVariant ? (
                <>
                  <span aria-hidden="true">-</span>
                  <span className="sr-only">escolha um tamanho</span>
                </>
              ) : (
                formatCents(totalCents)
              )}
            </span>
          </Button>
        </div>
        <p className="mx-auto mt-2 hidden max-w-2xl text-xs text-muted lg:block">
          O valor é informativo. O total oficial é calculado pelo restaurante no checkout.
        </p>
      </div>
    </div>
  );
}
