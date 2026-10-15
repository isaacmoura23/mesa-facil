import type { Menu, Product, Variant } from "./types.js";

export type FormatCentsOptions = {
  locale?: string;
  currency?: string;
};

/** Formata centavos inteiros como moeda (padrão pt-BR / BRL): 1250 -> "R$ 12,50". */
export function formatCents(cents: number, options: FormatCentsOptions = {}): string {
  return new Intl.NumberFormat(options.locale ?? "pt-BR", {
    style: "currency",
    currency: options.currency ?? "BRL",
  }).format(cents / 100);
}

export type LowestPrice = {
  cents: number;
  /** `true` quando exibir "a partir de" (há variantes com preços diferentes). */
  isFrom: boolean;
};

/**
 * Menor preço do produto. Com variantes, considera as disponíveis (se nenhuma
 * estiver disponível, todas) e marca `isFrom` quando os preços diferem.
 * Sem variantes, usa `priceCents` e `isFrom` é `false`.
 */
export function lowestPrice(product: Pick<Product, "priceCents" | "variants">): LowestPrice {
  const variants: Variant[] = product.variants ?? [];
  if (variants.length === 0) return { cents: product.priceCents, isFrom: false };
  const available = variants.filter((v) => v.isAvailable);
  const pool = available.length > 0 ? available : variants;
  const prices = pool.map((v) => v.priceCents);
  const cents = Math.min(...prices);
  return { cents, isFrom: prices.some((p) => p !== cents) };
}

/** Texto pronto: "R$ 12,50" ou "a partir de R$ 12,50". */
export function formatLowestPrice(
  product: Pick<Product, "priceCents" | "variants">,
  options: FormatCentsOptions = {},
): string {
  const { cents, isFrom } = lowestPrice(product);
  const price = formatCents(cents, options);
  return isFrom ? `a partir de ${price}` : price;
}

/** Aberto agora, segundo o servidor (horários, exceções e fuso do restaurante). */
export function isOpenNow(menu: Pick<Menu, "isOpenNow">): boolean {
  return menu.isOpenNow === true;
}
