/** Mapeia erros estáveis do banco/RPC para mensagens PT-BR. */

export type ActionError = {
  code: string;
  message: string;
  /** Vale a pena recarregar o pedido (estado mudou por outro caminho). */
  stale: boolean;
};

const MESSAGES: Record<string, { message: string; stale?: boolean }> = {
  ORDER_INVALID_TRANSITION: {
    message: "Este pedido já mudou de estado. A lista foi atualizada.",
    stale: true,
  },
  REASON_REQUIRED: { message: "Informe o motivo para continuar." },
  FORBIDDEN: { message: "Você não tem permissão para esta ação." },
  FORBIDDEN_FIELD: { message: "Você não tem permissão para esta ação." },
  ORDER_NOT_FOUND: { message: "Pedido não encontrado.", stale: true },
  INVALID_STATUS: { message: "Estado inválido para este pedido." },
  UNAUTHENTICATED: { message: "Sua sessão expirou. Entre novamente para continuar." },
  REASON_TOO_LONG: { message: "O motivo é muito longo (máximo de 500 caracteres)." },
};

type ErrorLike = { message?: string; code?: string } | null | undefined;

export function parseActionError(error: ErrorLike): ActionError {
  const raw = error?.message ?? "";
  const match = /^([A-Z][A-Z_]+)\b/.exec(raw);
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
