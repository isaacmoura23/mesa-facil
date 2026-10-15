import { z } from "zod";

/**
 * Tipos do módulo de cardápio (admin). As linhas vindas do banco são validadas
 * em tempo de execução com os schemas abaixo (o cliente Supabase ainda não tem
 * tipos gerados), então os tipos TypeScript são derivados deles.
 */

export const categoryRowSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  sort_order: z.number(),
  is_active: z.boolean(),
});
export type MenuCategory = z.infer<typeof categoryRowSchema>;

export const productRowSchema = z.object({
  id: z.string(),
  category_id: z.string().nullable(),
  name: z.string(),
  description: z.string().nullable(),
  price_cents: z.number(),
  image_path: z.string().nullable(),
  is_available: z.boolean(),
  is_active: z.boolean(),
  sort_order: z.number(),
  badges: z.array(z.string()),
});
export type MenuProduct = z.infer<typeof productRowSchema>;

export const variantRowSchema = z.object({
  id: z.string(),
  product_id: z.string(),
  name: z.string(),
  price_cents: z.number(),
  sort_order: z.number(),
  is_available: z.boolean(),
  is_default: z.boolean(),
});
export type MenuVariant = z.infer<typeof variantRowSchema>;

export const modifierGroupRowSchema = z.object({
  id: z.string(),
  name: z.string(),
  min_selections: z.number(),
  max_selections: z.number(),
  is_active: z.boolean(),
  sort_order: z.number(),
});
export type ModifierGroup = z.infer<typeof modifierGroupRowSchema>;

export const modifierRowSchema = z.object({
  id: z.string(),
  group_id: z.string(),
  name: z.string(),
  price_delta_cents: z.number(),
  is_available: z.boolean(),
  sort_order: z.number(),
});
export type Modifier = z.infer<typeof modifierRowSchema>;

export const productGroupLinkRowSchema = z.object({
  product_id: z.string(),
  group_id: z.string(),
});
export type ProductGroupLink = z.infer<typeof productGroupLinkRowSchema>;

/** Tudo o que a tela de administração precisa, já ordenado. */
export type MenuAdminData = {
  categories: MenuCategory[];
  products: MenuProduct[];
  /** Tamanhos ativos de todos os produtos, ordenados por `sort_order`. */
  variants: MenuVariant[];
  groups: ModifierGroup[];
  modifiers: Modifier[];
  links: ProductGroupLink[];
};

export type MenuAdminResult =
  | { ok: true; data: MenuAdminData }
  | { ok: false; message: string };

/** O que as Server Actions devolvem (serializável). */
export type ActionResult =
  | { ok: true; message?: string; warning?: string }
  | { ok: false; message: string; fieldErrors?: Record<string, string> };

export type ReorderKind = "category" | "product" | "modifier_group" | "modifier";

export type MenuRestaurant = {
  id: string;
  slug: string;
  name: string;
  status: "pending" | "active" | "suspended";
};
