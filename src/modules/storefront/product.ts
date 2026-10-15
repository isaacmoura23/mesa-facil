import type { MenuProduct, MenuVariant } from "./schemas";

/** Produto com tamanhos: o cliente precisa escolher um antes de adicionar. */
export function hasVariants(product: Pick<MenuProduct, "variants">): boolean {
  return product.variants.length > 0;
}

/** Pode ser pedido: disponível e, se tiver tamanhos, com pelo menos um disponível. */
export function isOrderable(product: Pick<MenuProduct, "isAvailable" | "variants">): boolean {
  return product.isAvailable && (!hasVariants(product) || product.variants.some((v) => v.isAvailable));
}

/** Tamanho pré-selecionado: o padrão disponível; senão o único disponível; senão nenhum. */
export function initialVariantId(product: Pick<MenuProduct, "variants">): string {
  const available = product.variants.filter((v) => v.isAvailable);
  const preset = available.find((v) => v.isDefault) ?? (available.length === 1 ? available[0] : null);
  return preset?.id ?? "";
}

export function findVariant(
  product: Pick<MenuProduct, "variants">,
  variantId: string,
): MenuVariant | null {
  return product.variants.find((v) => v.id === variantId) ?? null;
}
