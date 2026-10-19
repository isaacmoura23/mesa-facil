/**
 * Resultado tipado das leituras e tradução dos erros das RPCs (`CODIGO: texto`)
 * para mensagens amigáveis. Nunca expõe o texto bruto do banco.
 */
export type Failure = { ok: false; code: string | null; message: string };
export type Result<T> = { ok: true; data: T } | Failure;

const CODE_RE = /^([A-Z][A-Z_]+):/;

export function rpcErrorCode(message: string | null | undefined): string | null {
  const match = message ? CODE_RE.exec(message.trim()) : null;
  return match ? match[1] : null;
}

const MESSAGES: Record<string, string> = {
  UNAUTHENTICATED: "Sua sessão expirou. Entre novamente para continuar.",
  RESTAURANT_NOT_FOUND: "Restaurante não encontrado.",
  FORBIDDEN: "Você não tem permissão para ver estes dados.",
  INVALID_PERIOD: "O período escolhido é inválido. Ajuste as datas e tente de novo.",
  INVALID_REPORT: "Relatório desconhecido.",
  INVALID_GROUP: "Agrupamento inválido.",
  INVALID_CURSOR: "A página de resultados expirou. Volte ao início da lista.",
  CUSTOMER_NOT_FOUND: "Cliente não encontrado.",
};

export const LOAD_ERROR =
  "Não foi possível carregar os dados agora. Atualize a página ou tente novamente em instantes.";

export function failureFrom(error: { message?: string | null }): Failure {
  const code = rpcErrorCode(error.message);
  return { ok: false, code, message: (code && MESSAGES[code]) || LOAD_ERROR };
}

export function loadFailure(): Failure {
  return { ok: false, code: null, message: LOAD_ERROR };
}
