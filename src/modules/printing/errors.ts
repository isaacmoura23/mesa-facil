/** Erros estáveis das RPCs de impressão (prefixo "CODIGO: texto") em PT-BR. */

const MESSAGES: Record<string, string> = {
  UNAUTHENTICATED: "Sua sessão expirou. Entre novamente para imprimir.",
  ORDER_NOT_FOUND: "Pedido não encontrado ou sem acesso.",
  FORBIDDEN: "Você não tem permissão para imprimir pedidos.",
  INVALID_DOCUMENT_TYPE: "Tipo de documento inválido para este pedido.",
  PRINT_JOB_NOT_FOUND: "O pedido de impressão não foi encontrado.",
  INVALID_PRINT_STATUS: "Estado de impressão inválido.",
  PRINT_INVALID_TRANSITION: "Este pedido de impressão já está em outro estado.",
};

export function parsePrintError(error: { message?: string; code?: string } | null | undefined): string {
  const raw = error?.message ?? "";
  const code = /^([A-Z][A-Z_]+)\b/.exec(raw)?.[1] ?? (error?.code === "42501" ? "FORBIDDEN" : "");
  return MESSAGES[code] ?? "Não foi possível falar com o servidor. Verifique a conexão e tente novamente.";
}
