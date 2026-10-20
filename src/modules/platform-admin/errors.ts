import { GENERIC_ERROR_MESSAGE, RPC_ERROR_MESSAGES, rpcErrorMessage } from "@/lib/errors";
import type { ActionResult } from "./types";

/** Códigos `CODIGO: texto` das RPCs da Fase 6 -> PT-BR. Texto cru nunca sai daqui. */
const PREFIX_MESSAGES: Record<string, string> = {
  NOT_AUTHENTICATED: RPC_ERROR_MESSAGES.not_authenticated,
  UNAUTHENTICATED: RPC_ERROR_MESSAGES.not_authenticated,
  FORBIDDEN: "Você não tem permissão para esta ação. Apenas superadministradores podem alterar a plataforma.",
  INVALID_PLAN: "Plano inválido. Revise o código, o nome, o preço e os limites.",
  INVALID_CODE: "Código do plano inválido. Use de 2 a 40 letras minúsculas, números ou hífen.",
  INVALID_NAME: "Nome inválido.",
  INVALID_PRICE: "Preço inválido.",
  INVALID_LIMITS: "Limites inválidos. Use números inteiros maiores ou iguais a zero.",
  INVALID_FEATURES: "Lista de recursos inválida.",
  CODE_TAKEN: "Já existe um plano com este código.",
  LAST_ACTIVE_PLAN: "Mantenha ao menos um plano ativo. Ative outro plano antes de inativar este.",
  PLAN_INACTIVE: "Este plano está inativo e não pode ser atribuído a novas assinaturas.",
  REASON_REQUIRED: "Informe o motivo (mínimo de 10 caracteres).",
  INVALID_SETTING_KEY: "Configuração desconhecida.",
  INVALID_SETTING_VALUE: "Valor inválido para esta configuração.",
  PLAN_CODE_TAKEN: "Já existe um plano com este código.",
  PLAN_CODE_EXISTS: "Já existe um plano com este código.",
  DUPLICATE_CODE: "Já existe um plano com este código.",
  PLAN_IN_USE: "O código de um plano em uso por assinaturas não pode ser alterado. Para retirá-lo de circulação, apenas inative-o.",
  PLAN_NOT_FOUND: "Plano não encontrado. Atualize a página.",
  INVALID_STATUS: "Estado inválido.",
  INVALID_PERIOD: "Data de fim do período inválida.",
  INVALID_NOTE: "Observação inválida.",
  INVALID_REASON: "Informe um motivo válido.",
  RESTAURANT_NOT_FOUND: "Restaurante não encontrado.",
  SUBSCRIPTION_NOT_FOUND: "Assinatura não encontrada.",
  TICKET_NOT_FOUND: "Ticket não encontrado. Atualize a página.",
  SUPPORT_SESSION_INVALID: "Esta sessão de suporte expirou, foi encerrada ou não pertence a você.",
  INVALID_PREFIX: "Prefixo de ação inválido.",
  SESSION_NOT_FOUND: "Sessão de suporte não encontrada.",
  SESSION_EXPIRED: "Esta sessão de suporte já expirou ou foi encerrada.",
  SESSION_NOT_ACTIVE: "Esta sessão de suporte já expirou ou foi encerrada.",
  INVALID_SETTING: "Configuração inválida.",
  INVALID_KEY: "Configuração desconhecida.",
  INVALID_VALUE: "Valor inválido para esta configuração.",
  INVALID_CURSOR: "A lista mudou. Atualize a página.",
  REGISTRATION_DISABLED: "Os cadastros de novos restaurantes estão desativados.",
};

type DbError = { message?: string; code?: string } | null | undefined;

export function errorMessage(error: DbError): string {
  const code = error?.code;
  if (code === "PGRST301" || code === "PGRST303") return RPC_ERROR_MESSAGES.not_authenticated;
  if (code === "PGRST202" || code === "42883") return "Esta operação ainda não está disponível neste ambiente.";
  if (code === "42501") return PREFIX_MESSAGES.FORBIDDEN;
  const match = /^\s*(?:ERROR:\s*)?([A-Z][A-Z_]+)\s*:/.exec(error?.message ?? "");
  if (match && Object.hasOwn(PREFIX_MESSAGES, match[1])) return PREFIX_MESSAGES[match[1]];
  return rpcErrorMessage(error, GENERIC_ERROR_MESSAGE);
}

export function failure(error: DbError): Extract<ActionResult, { ok: false }> {
  return { ok: false, message: errorMessage(error) };
}

export const LOAD_ERROR = "Não foi possível carregar os dados agora. Tente novamente em instantes.";
