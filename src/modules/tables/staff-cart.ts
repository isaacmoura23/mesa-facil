import {
  MAX_LINES,
  clampQuantity,
  estimatedSubtotalCents,
  withAddedLine,
  type CartLine,
  type CartLineInput,
  type CartState,
} from "@/modules/storefront/cart";
import type { StaffCartItemPayload } from "./types";

/**
 * Carrinho LOCAL do lançamento da equipe (somente memória). Reaproveita o
 * modelo e os helpers puros do carrinho da vitrine; o preço mostrado é uma
 * estimativa, o servidor (`create_staff_order`) reprecifica tudo.
 */

export { MAX_LINES };

export const EMPTY_STAFF_CART: CartState = { version: 2, lines: [] };

export function addToStaffCart(state: CartState, input: CartLineInput): CartState {
  return withAddedLine(state, input);
}

export function setLineQuantity(state: CartState, lineId: string, quantity: number): CartState {
  if (quantity < 1) return removeLine(state, lineId);
  return {
    ...state,
    lines: state.lines.map((line) =>
      line.id === lineId ? { ...line, quantity: clampQuantity(quantity) } : line,
    ),
  };
}

export function removeLine(state: CartState, lineId: string): CartState {
  return { ...state, lines: state.lines.filter((line) => line.id !== lineId) };
}

export function staffCartCount(lines: CartLine[]): number {
  return lines.reduce((sum, line) => sum + line.quantity, 0);
}

export function staffCartEstimate(lines: CartLine[]): number {
  return estimatedSubtotalCents(lines);
}

/** Formato esperado por `create_staff_order` (igual ao de `validate_cart`). */
export function toStaffPayload(lines: CartLine[]): StaffCartItemPayload[] {
  return lines.map((line) => {
    const notes = line.notes.trim();
    return {
      product_id: line.productId,
      variant_id: line.variantId,
      quantity: line.quantity,
      modifier_ids: line.modifierIds,
      ...(notes ? { notes } : {}),
    };
  });
}

/** UUID v4 da TENTATIVA de lançamento (chave de idempotência de create_staff_order). */
export function newAttemptKey(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") return crypto.randomUUID();
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  return [hex.slice(0, 8), hex.slice(8, 12), hex.slice(12, 16), hex.slice(16, 20), hex.slice(20)].join("-");
}
