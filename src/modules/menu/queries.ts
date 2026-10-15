import "server-only";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import {
  categoryRowSchema,
  modifierGroupRowSchema,
  modifierRowSchema,
  productGroupLinkRowSchema,
  productRowSchema,
  variantRowSchema,
  type MenuAdminResult,
} from "./types";

const LOAD_ERROR =
  "Não foi possível carregar o cardápio agora. Atualize a página ou tente novamente em instantes.";

/** Limite explícito (o PostgREST corta em 1000 linhas por padrão). */
const ROW_LIMIT = 1000;

/**
 * Carrega o cardápio completo do restaurante (inclusive itens inativos) com o
 * cliente Supabase do usuário: a RLS decide o que ele enxerga. O filtro por
 * `restaurant_id` é redundante de propósito (defesa em profundidade e índice).
 */
export async function getMenuAdminData(restaurantId: string): Promise<MenuAdminResult> {
  const supabase = await createClient();

  const [categories, products, variants, groups, modifiers, links] = await Promise.all([
    supabase
      .from("menu_categories")
      .select("id, name, description, sort_order, is_active")
      .eq("restaurant_id", restaurantId)
      .order("sort_order")
      .order("created_at")
      .limit(ROW_LIMIT),
    supabase
      .from("products")
      .select(
        "id, category_id, name, description, price_cents, image_path, is_available, is_active, sort_order, badges",
      )
      .eq("restaurant_id", restaurantId)
      .order("sort_order")
      .order("created_at")
      .limit(ROW_LIMIT),
    supabase
      .from("product_variants")
      .select("id, product_id, name, price_cents, sort_order, is_available, is_default")
      .eq("restaurant_id", restaurantId)
      .eq("is_active", true)
      .order("sort_order")
      .order("created_at")
      .limit(ROW_LIMIT * 5),
    supabase
      .from("modifier_groups")
      .select("id, name, min_selections, max_selections, is_active, sort_order")
      .eq("restaurant_id", restaurantId)
      .order("sort_order")
      .order("created_at")
      .limit(ROW_LIMIT),
    supabase
      .from("modifiers")
      .select("id, group_id, name, price_delta_cents, is_available, sort_order")
      .eq("restaurant_id", restaurantId)
      .order("sort_order")
      .order("created_at")
      .limit(ROW_LIMIT * 5),
    supabase
      .from("product_modifier_groups")
      .select("product_id, group_id")
      .eq("restaurant_id", restaurantId)
      .limit(ROW_LIMIT * 5),
  ]);

  if (categories.error || products.error || variants.error || groups.error || modifiers.error || links.error) {
    return { ok: false, message: LOAD_ERROR };
  }

  const parsed = {
    categories: z.array(categoryRowSchema).safeParse(categories.data),
    products: z.array(productRowSchema).safeParse(products.data),
    variants: z.array(variantRowSchema).safeParse(variants.data),
    groups: z.array(modifierGroupRowSchema).safeParse(groups.data),
    modifiers: z.array(modifierRowSchema).safeParse(modifiers.data),
    links: z.array(productGroupLinkRowSchema).safeParse(links.data),
  };

  if (
    !parsed.categories.success ||
    !parsed.products.success ||
    !parsed.variants.success ||
    !parsed.groups.success ||
    !parsed.modifiers.success ||
    !parsed.links.success
  ) {
    return { ok: false, message: LOAD_ERROR };
  }

  return {
    ok: true,
    data: {
      categories: parsed.categories.data,
      products: parsed.products.data,
      variants: parsed.variants.data,
      groups: parsed.groups.data,
      modifiers: parsed.modifiers.data,
      links: parsed.links.data,
    },
  };
}
