import { CART_ERROR_MESSAGES, GENERIC_CART_ERROR } from "@/modules/storefront/messages";

/**
 * Códigos de erro de `create_public_order` -> mensagens PT-BR para o cliente.
 * Códigos desconhecidos NUNCA exibem texto cru do banco.
 */
export const ORDER_ERROR_MESSAGES: Record<string, string> = {
  ...CART_ERROR_MESSAGES,
  VARIANT_REQUIRED: "Escolha o tamanho deste item para continuar.",
  VARIANT_UNAVAILABLE: "O tamanho escolhido está indisponível agora. Escolha outro tamanho.",
  VARIANT_NOT_ALLOWED: "O tamanho escolhido não está mais disponível para este item.",
  INVALID_PAYMENT_METHOD: "Escolha uma forma de pagamento válida.",
  CHANGE_NOT_ALLOWED: "Troco só se aplica a pagamento em dinheiro.",
  INVALID_CHANGE: "Informe um valor válido para o troco.",
  CHANGE_BELOW_TOTAL: "O valor para troco precisa ser maior ou igual ao total do pedido.",
  INVALID_CUSTOMER: "Confira seu nome e telefone.",
  INVALID_CUSTOMER_NAME: "Confira seu nome (de 2 a 80 caracteres).",
  INVALID_CUSTOMER_PHONE: "Confira seu telefone com DDD.",
  INVALID_CUSTOMER_EMAIL: "Confira seu e-mail.",
  ADDRESS_REQUIRED: "Informe o endereço de entrega.",
  ADDRESS_INCOMPLETE: "O endereço de entrega está incompleto.",
  ADDRESS_INVALID: "Confira o endereço de entrega.",
  INVALID_NOTES: "Confira as observações do pedido.",
  INVALID_IDEMPOTENCY_KEY: "Não foi possível identificar o envio. Recarregue a página e tente novamente.",
  IDEMPOTENCY_CONFLICT:
    "Este envio já foi usado com outro conteúdo. Recarregue a página e tente novamente.",
};

export const GENERIC_ORDER_ERROR =
  "Não foi possível enviar o pedido agora. Tente novamente em instantes.";

export function orderErrorMessage(code: string): string {
  return Object.hasOwn(ORDER_ERROR_MESSAGES, code) ? ORDER_ERROR_MESSAGES[code] : GENERIC_CART_ERROR;
}
