/** Mapeia erros estáveis (prefixo `CODIGO:`) das RPCs de mesas/comandas para PT-BR. */

export type TabsError = {
  code: string;
  message: string;
  /** Vale reler mesas/comandas (o estado mudou por outro caminho). */
  stale: boolean;
};

const MESSAGES: Record<string, { message: string; stale?: boolean }> = {
  TABLE_HAS_OPEN_TAB: { message: "Esta mesa já tem uma comanda aberta.", stale: true },
  TABLE_INACTIVE: { message: "Esta mesa está inativa e não pode receber comanda.", stale: true },
  TABLE_NOT_AVAILABLE: { message: "A mesa não está livre. A lista foi atualizada.", stale: true },
  TABLE_NOT_FOUND: { message: "Mesa não encontrada.", stale: true },
  TABLE_INVALID_TRANSITION: { message: "A mesa mudou de estado. A lista foi atualizada.", stale: true },
  INVALID_TABLE_TRANSITION: { message: "A mesa mudou de estado. A lista foi atualizada.", stale: true },
  TABLE_HAS_OPEN_TAB_CANNOT_CHANGE: { message: "A mesa tem comanda aberta.", stale: true },
  TAB_NOT_FOUND: { message: "Comanda não encontrada.", stale: true },
  TAB_NOT_OPEN: { message: "Esta comanda não está mais aberta.", stale: true },
  TAB_CLOSED: { message: "Esta comanda já foi encerrada.", stale: true },
  EMPTY_CART: { message: "Adicione ao menos um item ao pedido." },
  CART_EMPTY: { message: "Adicione ao menos um item ao pedido." },
  INVALID_ITEMS: { message: "Algum item do pedido é inválido. Revise o carrinho." },
  VARIANT_REQUIRED: { message: "Escolha o tamanho de todos os itens que exigem." },
  PRODUCT_UNAVAILABLE: { message: "Um dos itens ficou indisponível. Remova-o e tente de novo." },
  VARIANT_UNAVAILABLE: { message: "Um tamanho escolhido ficou indisponível. Revise o carrinho." },
  MODIFIER_UNAVAILABLE: { message: "Um adicional ficou indisponível. Revise o carrinho." },
  MODIFIER_RULE_VIOLATION: { message: "Revise os adicionais: há grupo fora do mínimo ou máximo." },
  RESTAURANT_INACTIVE: { message: "O restaurante não está ativo." },
  REASON_TOO_LONG: { message: "O texto informado é muito longo." },
  FORBIDDEN: { message: "Você não tem permissão para esta ação." },
  FORBIDDEN_FIELD: { message: "Você não tem permissão para esta ação." },
  UNAUTHENTICATED: { message: "Sua sessão expirou. Entre novamente para continuar." },
};

type ErrorLike = { message?: string; code?: string } | null | undefined;

export function parseTabsError(error: ErrorLike): TabsError {
  const raw = error?.message ?? "";
  const match = /^([A-Z][A-Z0-9_]+)\b/.exec(raw);
  let code = match?.[1] ?? "";
  if (!code && error?.code === "42501") code = "FORBIDDEN";
  const known = MESSAGES[code];
  if (known) return { code, message: known.message, stale: Boolean(known.stale) };
  return {
    code: code || "UNKNOWN",
    message: "Não foi possível concluir a ação. Verifique a conexão e tente novamente.",
    stale: false,
  };
}
