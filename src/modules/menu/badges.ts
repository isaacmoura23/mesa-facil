/**
 * Selos (badges) do produto. Os valores são os do CHECK `products_badges_valid`
 * do banco e os que a API pública devolve em `badges[]`.
 */
export const PRODUCT_BADGES = ["NEW", "POPULAR", "REGIONAL", "SWEET", "SPICY", "VEGETARIAN"] as const;

export type ProductBadge = (typeof PRODUCT_BADGES)[number];

/** Limite do banco (cardinality(badges) <= 4). */
export const MAX_BADGES = 4;

export const BADGE_LABELS: Record<ProductBadge, string> = {
  NEW: "Novo",
  POPULAR: "Popular",
  REGIONAL: "Regional",
  SWEET: "Doce",
  SPICY: "Picante",
  VEGETARIAN: "Vegetariano",
};

export type BadgeChipTone = "neutral" | "accent" | "warning" | "danger" | "info";

export const BADGE_TONES: Record<ProductBadge, BadgeChipTone> = {
  NEW: "info",
  POPULAR: "accent",
  REGIONAL: "neutral",
  SWEET: "warning",
  SPICY: "danger",
  VEGETARIAN: "accent",
};

export function isProductBadge(value: string): value is ProductBadge {
  return (PRODUCT_BADGES as readonly string[]).includes(value);
}

/** Mantém só selos conhecidos, sem repetir, na ordem recebida (dados vindos do banco). */
export function knownBadges(values: readonly string[]): ProductBadge[] {
  const result: ProductBadge[] = [];
  for (const value of values) {
    if (isProductBadge(value) && !result.includes(value)) result.push(value);
  }
  return result;
}
