/**
 * Erros das RPCs chegam em `error.message` como códigos estáveis (ex.:
 * "slug_unavailable"). Este mapa os converte em mensagens PT-BR para a UI.
 * Mensagens desconhecidas NUNCA são exibidas cruas (podem vazar detalhes do banco).
 */
export const RPC_ERROR_MESSAGES = {
  not_authenticated: "Sua sessão expirou. Entre novamente.",
  forbidden: "Você não tem permissão para realizar esta ação.",
  invalid_slug:
    "Endereço inválido ou reservado. Use de 3 a 63 letras minúsculas, números e hífen, e escolha outro nome.",
  slug_unavailable: "Este endereço já está em uso. Escolha outro.",
  invalid_name: "Nome inválido. Use de 2 a 120 caracteres.",
  owner_not_found: "Proprietário não encontrado.",
  invalid_role: "Papel inválido.",
  invalid_email: "E-mail inválido.",
  already_member: "Esta pessoa já faz parte do restaurante.",
  invitation_not_found:
    "Convite não encontrado ou não disponível para a sua conta. Confirme seu e-mail e tente novamente.",
  cannot_modify_self: "Você não pode alterar o seu próprio vínculo.",
  owner_protected: "O proprietário não pode ser alterado ou removido por aqui.",
  owner_permissions_are_fixed:
    "As permissões do proprietário são fixas e não podem ser alteradas.",
  team_manage_not_delegable: "A gestão da equipe não pode ser delegada.",
  unknown_permission: "Permissão desconhecida.",
  membership_revoked: "Este vínculo foi revogado.",
  invalid_reason: "Informe um motivo válido.",
  invalid_duration: "Duração inválida.",
  restaurant_not_found: "Restaurante não encontrado.",
  restaurant_limit_reached:
    "Você atingiu o limite de restaurantes que podem ser registrados por conta.",
  restaurant_suspended: "Este restaurante está suspenso.",
} as const;

export type RpcErrorCode = keyof typeof RPC_ERROR_MESSAGES;

export const GENERIC_ERROR_MESSAGE =
  "Não foi possível concluir a operação agora. Tente novamente em instantes.";

export function isRpcErrorCode(value: string): value is RpcErrorCode {
  return Object.hasOwn(RPC_ERROR_MESSAGES, value);
}

/** Extrai o código estável de um erro de RPC (ou `null` se desconhecido). */
export function rpcErrorCode(error: { message?: string } | null | undefined): RpcErrorCode | null {
  const message = error?.message?.trim();
  if (!message) return null;
  if (isRpcErrorCode(message)) return message;
  // Tolera prefixos/sufixos (ex.: "ERROR: slug_unavailable").
  const found = Object.keys(RPC_ERROR_MESSAGES).find((code) => message.includes(code));
  return found && isRpcErrorCode(found) ? found : null;
}

/** Mensagem PT-BR para exibir ao usuário. */
export function rpcErrorMessage(
  error: { message?: string } | null | undefined,
  fallback: string = GENERIC_ERROR_MESSAGE,
): string {
  const code = rpcErrorCode(error);
  return code ? RPC_ERROR_MESSAGES[code] : fallback;
}
