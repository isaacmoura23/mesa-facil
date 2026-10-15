/**
 * Códigos de erro de `validate_cart` -> mensagens PT-BR para o cliente final.
 * Códigos desconhecidos NUNCA exibem o texto cru do servidor.
 */
export const CART_ERROR_MESSAGES: Record<string, string> = {
  RESTAURANT_UNAVAILABLE: "Este restaurante não está recebendo pedidos no momento.",
  RESTAURANT_CLOSED:
    "O restaurante está fechado agora. Volte no horário de funcionamento para fazer o pedido.",
  FULFILLMENT_DISABLED: "Esta forma de recebimento não está disponível. Escolha outra.",
  PRODUCT_UNAVAILABLE: "Este item não está mais disponível. Remova-o do carrinho.",
  VARIANT_REQUIRED: "Escolha o tamanho deste item para continuar.",
  VARIANT_NOT_ALLOWED:
    "O tamanho escolhido não está mais disponível para este item. Escolha o tamanho de novo.",
  VARIANT_UNAVAILABLE: "O tamanho escolhido está indisponível agora. Escolha outro tamanho.",
  MODIFIER_UNAVAILABLE: "Um adicional escolhido não está mais disponível. Remova o item e adicione de novo.",
  MODIFIER_NOT_ALLOWED:
    "Um adicional escolhido não pertence a este item. Remova o item e adicione de novo.",
  MODIFIER_GROUP_MIN: "Faltam adicionais obrigatórios neste item. Remova o item e adicione de novo.",
  MODIFIER_GROUP_MAX: "Há adicionais demais neste item. Remova o item e adicione de novo.",
  TOO_MANY_MODIFIERS: "O carrinho tem adicionais em excesso. Remova alguns itens e tente novamente.",
  INVALID_QUANTITY: "A quantidade deste item é inválida.",
  NOTES_TOO_LONG: "A observação deste item é longa demais. Encurte o texto e tente novamente.",
  TOO_MANY_ITEMS: "O carrinho tem itens demais. Remova alguns e tente novamente.",
  TOO_MANY_ERRORS: "Há problemas demais no pedido. Corrija os primeiros e confira de novo.",
  BELOW_MINIMUM: "O valor dos itens está abaixo do pedido mínimo.",
  ZONE_REQUIRED: "Escolha a região de entrega.",
  ZONE_UNAVAILABLE: "Não entregamos na região escolhida. Escolha outra.",
  EMPTY_CART: "Seu carrinho está vazio.",
};

export const GENERIC_CART_ERROR =
  "Não foi possível conferir o pedido agora. Tente novamente em instantes.";

/** Códigos que se resolvem escolhendo/trocando o tamanho na página do produto. */
export const VARIANT_FIX_CODES: ReadonlySet<string> = new Set([
  "VARIANT_REQUIRED",
  "VARIANT_NOT_ALLOWED",
  "VARIANT_UNAVAILABLE",
]);

export function cartErrorMessage(code: string): string {
  // `hasOwn`: nomes herdados de Object.prototype ("constructor", "__proto__"...) não são mensagens (F-19).
  return Object.hasOwn(CART_ERROR_MESSAGES, code) ? CART_ERROR_MESSAGES[code] : GENERIC_CART_ERROR;
}
