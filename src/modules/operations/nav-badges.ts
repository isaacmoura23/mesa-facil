import type { OrderStatus } from "./types";

/**
 * Selos de contagem da barra lateral da Operação.
 * - `new_orders`: pedidos aguardando aceite (RECEBIDO) — o que o atendimento/caixa precisa aceitar.
 * - `kitchen_queue`: pedidos aceitos esperando a cozinha (CONFIRMADO) — o mesmo critério do alerta da cozinha.
 */
export const NAV_BADGE_KEYS = ["new_orders", "kitchen_queue"] as const;
export type NavBadgeKey = (typeof NAV_BADGE_KEYS)[number];

export const NAV_BADGE_STATUS: Record<NavBadgeKey, OrderStatus> = {
  new_orders: "RECEIVED",
  kitchen_queue: "CONFIRMED",
};

export const NAV_BADGE_MAX = 99;

/** Texto do selo: some com 0 (ou valor inválido) e limita em "99+". */
export function formatBadgeCount(
  count: number | undefined | null,
): string | null {
  if (
    count === undefined ||
    count === null ||
    !Number.isFinite(count) ||
    count <= 0
  )
    return null;
  const whole = Math.floor(count);
  return whole > NAV_BADGE_MAX ? `${NAV_BADGE_MAX}+` : String(whole);
}

/** Frase para leitor de tela e dica do ícone recolhido. */
export function badgeDescription(key: NavBadgeKey, count: number): string {
  const text = formatBadgeCount(count);
  if (!text) return "";
  const many = count > 1;
  return key === "new_orders"
    ? `${text} ${many ? "pedidos aguardando aceite" : "pedido aguardando aceite"}`
    : `${text} ${many ? "pedidos para preparar" : "pedido para preparar"}`;
}
