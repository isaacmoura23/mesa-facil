import { centsToInput } from "@/modules/menu/format";
import { MAX_VARIANTS } from "@/modules/menu/schemas";
import type { MenuVariant } from "@/modules/menu/types";

/**
 * Rascunho de um tamanho no formulário do produto. `id` vazio = ainda não salvo;
 * `key` identifica a linha na tela (estável durante a edição).
 */
export type VariantDraft = {
  key: string;
  id: string;
  name: string;
  /** Texto digitado ("25,90"). */
  price: string;
  isDefault: boolean;
  isAvailable: boolean;
};

export { MAX_VARIANTS };

export function draftsFromVariants(variants: readonly MenuVariant[]): VariantDraft[] {
  return variants.map((variant) => ({
    key: variant.id,
    id: variant.id,
    name: variant.name,
    price: centsToInput(variant.price_cents),
    isDefault: variant.is_default,
    isAvailable: variant.is_available,
  }));
}

export function newVariantDraft(isDefault: boolean): VariantDraft {
  return {
    key: `new-${crypto.randomUUID()}`,
    id: "",
    name: "",
    price: "",
    isDefault,
    isAvailable: true,
  };
}

/** Garante exatamente um padrão quando há linhas (preferindo uma disponível). */
export function ensureDefault(drafts: VariantDraft[]): VariantDraft[] {
  if (drafts.length === 0 || drafts.filter((draft) => draft.isDefault).length === 1) return drafts;
  const firstDefault = drafts.find((draft) => draft.isDefault);
  const chosen = firstDefault ?? drafts.find((draft) => draft.isAvailable) ?? drafts[0];
  return drafts.map((draft) => ({ ...draft, isDefault: draft.key === chosen.key }));
}

export function moveDraft(drafts: VariantDraft[], index: number, direction: -1 | 1): VariantDraft[] {
  const target = index + direction;
  if (index < 0 || target < 0 || target >= drafts.length) return drafts;
  const next = [...drafts];
  [next[index], next[target]] = [next[target], next[index]];
  return next;
}

/** JSON do campo `variants` esperado pela Server Action (mesmo schema do servidor). */
export function serializeDrafts(drafts: readonly VariantDraft[]): string {
  return JSON.stringify(
    drafts.map((draft) => ({
      id: draft.id,
      name: draft.name,
      price: draft.price,
      isDefault: draft.isDefault,
      isAvailable: draft.isAvailable,
    })),
  );
}
