"use server";

import { getPublicEnvStatus } from "@/lib/env";
import { createPublicClient } from "@/lib/supabase/server";
import {
  cartQuoteInputSchema,
  checkoutFormSchema,
  fieldErrorsFrom,
  type CheckoutFieldErrors,
} from "./checkout-schema";
import { normalizeSlug } from "./data";
import { GENERIC_CART_ERROR } from "./messages";
import { parseCartValidation, type CartValidation } from "./schemas";

/**
 * Server Actions do checkout. NENHUMA delas cria pedido: `validate_cart` só
 * recalcula e devolve totais. Usam o cliente anon (sem cookies/sessão).
 */

export type QuoteResult =
  | { status: "ok"; quote: CartValidation }
  | { status: "error"; message: string };

/** Recalcula o carrinho no servidor (preços, taxa, mínimo, horário, zona). */
export async function quoteCartAction(input: unknown): Promise<QuoteResult> {
  const parsed = cartQuoteInputSchema.safeParse(input);
  if (!parsed.success) return { status: "error", message: GENERIC_CART_ERROR };
  const { slug: rawSlug, fulfillment, zoneId, items } = parsed.data;

  const slug = normalizeSlug(rawSlug);
  if (!slug || !getPublicEnvStatus().ok) {
    return { status: "error", message: GENERIC_CART_ERROR };
  }

  try {
    const supabase = createPublicClient();
    const { data, error } = await supabase.rpc("validate_cart", {
      p_slug: slug,
      p_fulfillment: fulfillment,
      p_items: items.map((item) => ({
        product_id: item.productId,
        ...(item.variantId ? { variant_id: item.variantId } : {}),
        quantity: item.quantity,
        modifier_ids: item.modifierIds,
        ...(item.notes ? { notes: item.notes } : {}),
      })),
      p_delivery_zone_id: fulfillment === "DELIVERY" && zoneId ? zoneId : null,
    });
    if (error) {
      console.error("RPC validate_cart falhou:", error.message);
      return { status: "error", message: GENERIC_CART_ERROR };
    }
    const quote = parseCartValidation(Array.isArray(data) ? data[0] : data);
    if (!quote) {
      console.error("RPC validate_cart devolveu um formato inesperado.");
      return { status: "error", message: GENERIC_CART_ERROR };
    }
    return { status: "ok", quote };
  } catch (error) {
    console.error("validate_cart:", error);
    return { status: "error", message: GENERIC_CART_ERROR };
  }
}

export type ReviewResult =
  | { status: "invalid"; fieldErrors: CheckoutFieldErrors }
  | { status: "error"; message: string }
  | { status: "ok"; quote: CartValidation };

/**
 * Conferência completa (dados do cliente + carrinho) no servidor. Mesmo schema
 * do cliente; serve para provar que a validação não depende do navegador.
 * Não grava nada e não envia pedido.
 */
export async function reviewCheckoutAction(input: {
  form: unknown;
  cart: unknown;
}): Promise<ReviewResult> {
  const form = checkoutFormSchema.safeParse(input.form);
  if (!form.success) return { status: "invalid", fieldErrors: fieldErrorsFrom(form.error) };

  const cart = cartQuoteInputSchema.safeParse(input.cart);
  if (!cart.success) return { status: "error", message: GENERIC_CART_ERROR };

  const result = await quoteCartAction({
    ...cart.data,
    fulfillment: form.data.fulfillment,
    zoneId: form.data.zoneId || null,
  });
  return result.status === "ok" ? { status: "ok", quote: result.quote } : result;
}
