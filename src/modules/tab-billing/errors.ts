/** Erros estáveis das RPCs de comanda/pagamento (prefixo "CODIGO: texto") em PT-BR. */

export type BillingError = {
  code: string;
  message: string;
  /** O saldo/estado mudou por outro caminho: vale reler a comanda. */
  stale: boolean;
};

const MESSAGES: Record<string, { message: string; stale?: boolean }> = {
  UNAUTHENTICATED: { message: "Sua sessão expirou. Entre novamente para continuar." },
  FORBIDDEN: { message: "Você não tem permissão para esta ação." },
  TAB_NOT_FOUND: { message: "Comanda não encontrada ou sem acesso.", stale: true },
  TAB_NOT_OPEN: { message: "Esta comanda não está mais aberta. Os dados foram atualizados.", stale: true },
  TAB_CLOSED: { message: "Esta comanda já foi fechada. Os dados foram atualizados.", stale: true },
  OVERPAYMENT: {
    message: "O valor é maior que o saldo restante da comanda. O saldo foi atualizado: confira e tente de novo.",
    stale: true,
  },
  TAB_HAS_OPEN_ORDERS: {
    message: "Ainda há pedidos em andamento nesta comanda. Conclua ou cancele os pedidos antes de fechar.",
    stale: true,
  },
  TAB_UNPAID: {
    message: "A comanda ainda tem saldo a receber. Registre o pagamento ou feche informando uma justificativa.",
    stale: true,
  },
  TAB_NOT_EMPTY: { message: "Só é possível cancelar uma comanda sem pedidos ativos nem pagamentos.", stale: true },
  TAB_HAS_ORDERS: { message: "Só é possível cancelar uma comanda sem pedidos ativos nem pagamentos.", stale: true },
  TAB_HAS_PAYMENTS: { message: "Esta comanda já tem pagamentos registrados e não pode ser cancelada.", stale: true },
  REASON_REQUIRED: { message: "Informe o motivo para continuar." },
  REASON_TOO_SHORT: { message: "A justificativa precisa ter pelo menos 10 caracteres." },
  REASON_TOO_LONG: { message: "O texto é muito longo (máximo de 500 caracteres)." },
  UNPAID_REASON_REQUIRED: { message: "Informe a justificativa de fechamento com saldo (mínimo de 10 caracteres)." },
  INVALID_PAYMENT_METHOD: { message: "Forma de pagamento inválida." },
  INVALID_METHOD: { message: "Forma de pagamento inválida." },
  INVALID_UNPAID_REASON: { message: "A justificativa precisa ter entre 10 e 500 caracteres." },
  INVALID_REFERENCE: { message: "A referência é muito longa (máximo de 60 caracteres)." },
  IDEMPOTENCY_CONFLICT: { message: "Esta tentativa de pagamento já foi usada com outros dados. Confira o saldo e tente de novo.", stale: true },
  INVALID_TARGET: { message: "Pagamento sem comanda de destino." },
  ORDER_NOT_PAYABLE: { message: "Pedido cancelado ou recusado não recebe pagamento.", stale: true },
  INVALID_AMOUNT: { message: "Informe um valor maior que zero." },
  INVALID_TENDERED: { message: "O valor recebido em dinheiro não pode ser menor que o valor do pagamento." },
  TENDERED_ONLY_CASH: { message: "Valor recebido e troco só valem para pagamento em dinheiro." },
  INVALID_PAYMENT_TARGET: { message: "Pagamento sem comanda ou pedido de destino." },
};

type ErrorLike = { message?: string; code?: string } | null | undefined;

export function parseBillingError(error: ErrorLike): BillingError {
  const raw = error?.message ?? "";
  let code = /^([A-Z][A-Z_]+)\b/.exec(raw)?.[1] ?? "";
  if (!code && error?.code === "42501") code = "FORBIDDEN";
  const known = MESSAGES[code];
  if (known) return { code, message: known.message, stale: Boolean(known.stale) };
  return {
    code: code || "UNKNOWN",
    message: "Não foi possível concluir a ação. Verifique a conexão e tente novamente.",
    stale: false,
  };
}

export class BillingActionError extends Error {
  readonly code: string;
  readonly stale: boolean;
  constructor(info: BillingError) {
    super(info.message);
    this.name = "BillingActionError";
    this.code = info.code;
    this.stale = info.stale;
  }
}
