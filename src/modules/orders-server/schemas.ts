import { z } from "zod";
import { FULFILLMENTS, isUuid } from "@/modules/storefront/schemas";
import { isValidBrPhone, isValidCep, onlyDigits } from "@/modules/storefront/masks";

/**
 * Entrada de criação de pedido (camelCase), compartilhada pela Server Action da
 * vitrine padrão e pela API pública. Módulo PURO (sem server-only) para poder
 * ser importado pelos handlers e pelos testes. Nada aqui fala com o banco.
 */

export const PAYMENT_METHODS = ["CASH", "PIX", "CARD"] as const;
export type PaymentMethod = (typeof PAYMENT_METHODS)[number];

export const PAYMENT_METHOD_LABELS: Record<PaymentMethod, string> = {
  CASH: "Dinheiro",
  PIX: "Pix",
  CARD: "Cartão",
};

export const MAX_ORDER_ITEMS = 50;
export const MAX_ITEM_MODIFIERS = 50;
export const MAX_ITEM_NOTES = 500;
export const MAX_ORDER_NOTES = 500;
export const MAX_CENTS = 100_000_000;

const uuid = z.string().refine(isUuid, "Identificador inválido.");

/** Chave de idempotência: 16 a 100 caracteres [A-Za-z0-9_-] (um UUID serve). */
export const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9_-]{16,100}$/;
export const idempotencyKeySchema = z
  .string()
  .regex(IDEMPOTENCY_KEY_PATTERN, "Chave de idempotência inválida (16 a 100 caracteres: letras, números, - e _).");

const trimmed = (max: number, message = "Texto muito longo.") => z.string().trim().max(max, message);
const optionalText = (max: number) => trimmed(max).nullish();

const itemSchema = z.object({
  productId: uuid,
  variantId: uuid.nullish(),
  quantity: z.number().int().min(1, "Quantidade inválida.").max(99, "Quantidade inválida."),
  modifierIds: z.array(uuid).max(MAX_ITEM_MODIFIERS).default([]),
  notes: optionalText(MAX_ITEM_NOTES),
});

const customerSchema = z.object({
  name: z.string().trim().min(2, "Informe seu nome.").max(80, "Nome muito longo (máximo de 80 caracteres)."),
  phone: z
    .string()
    .trim()
    .refine(isValidBrPhone, "Informe um telefone válido com DDD, ex.: (11) 91234-5678."),
  email: z
    .string()
    .trim()
    .max(254, "E-mail muito longo.")
    .refine((v) => v === "" || z.email().safeParse(v).success, "Informe um e-mail válido.")
    .nullish(),
});

const addressSchema = z.object({
  street: z.string().trim().min(1, "Informe a rua.").max(160, "Texto muito longo."),
  number: z.string().trim().min(1, "Informe o número.").max(20, "Texto muito longo."),
  neighborhood: z.string().trim().min(1, "Informe o bairro.").max(120, "Texto muito longo."),
  city: z.string().trim().min(1, "Informe a cidade.").max(120, "Texto muito longo."),
  postalCode: z
    .string()
    .trim()
    .refine((v) => v === "" || isValidCep(v), "CEP inválido. Use 8 dígitos.")
    .nullish(),
  complement: optionalText(120),
  instructions: optionalText(300),
});

const paymentSchema = z.object({
  method: z.enum(PAYMENT_METHODS, { error: "Escolha a forma de pagamento." }),
  /** Valor com que o cliente vai pagar em dinheiro (para levar troco). */
  changeForCents: z.number().int().min(1).max(MAX_CENTS).nullish(),
});

const orderObject = z.object({
  fulfillmentType: z.enum(FULFILLMENTS, { error: "Escolha como quer receber o pedido." }),
  items: z.array(itemSchema).min(1, "O pedido precisa de pelo menos um item.").max(MAX_ORDER_ITEMS),
  customer: customerSchema,
  address: addressSchema.nullish(),
  deliveryZoneId: uuid.nullish(),
  notes: optionalText(MAX_ORDER_NOTES),
  payment: paymentSchema,
  idempotencyKey: idempotencyKeySchema.optional(),
});

type OrderShape = z.infer<typeof orderObject>;

function checkRules(value: OrderShape, ctx: z.RefinementCtx): void {
  if (value.fulfillmentType === "DELIVERY") {
    if (!value.address) {
      ctx.addIssue({ code: "custom", path: ["address"], message: "Informe o endereço de entrega." });
    }
    if (!value.deliveryZoneId) {
      ctx.addIssue({ code: "custom", path: ["deliveryZoneId"], message: "Escolha a região de entrega." });
    }
  }
  if (value.payment.method !== "CASH" && value.payment.changeForCents != null) {
    ctx.addIssue({
      code: "custom",
      path: ["payment", "changeForCents"],
      message: "Troco só se aplica a pagamento em dinheiro.",
    });
  }
}

/** Corpo da API (a chave de idempotência pode vir no header `Idempotency-Key`). */
export const createOrderBodySchema = orderObject.superRefine(checkRules);
export type CreateOrderBody = z.infer<typeof createOrderBodySchema>;

/** Entrada final do serviço: a chave de idempotência é obrigatória. */
export const orderSubmissionSchema = orderObject
  .extend({ idempotencyKey: idempotencyKeySchema })
  .superRefine(checkRules);
export type OrderSubmission = z.infer<typeof orderSubmissionSchema>;

/** Código público do pedido (o único segredo do acompanhamento). */
export const PUBLIC_CODE_PATTERN = /^[A-Za-z0-9-]{3,40}$/;
export const isPublicCode = (value: unknown): value is string =>
  typeof value === "string" && PUBLIC_CODE_PATTERN.test(value);

// ---------------------------------------------------------------------------
// Saída
// ---------------------------------------------------------------------------

export type OrderErrorItem = {
  code: string;
  /** Campo do pedido com problema (ex.: "customer.phone"), quando houver. */
  field: string | null;
  /** Índice (base 0) do item em `items`, quando o erro é de um item. */
  itemIndex: number | null;
  /** Mensagem PT-BR segura para o cliente final (nunca texto cru do banco). */
  message: string;
};

export type CreatedOrder = {
  publicCode: string;
  orderNumber: number;
  status: string;
  totalCents: number;
  subtotalCents: number;
  deliveryFeeCents: number;
  estimatedReadyAt: string | null;
  /** true quando a chave de idempotência já tinha gerado este pedido. */
  idempotentReplay: boolean;
};

export type SubmitOrderResult =
  | { status: "created"; order: CreatedOrder }
  /** Regras de negócio (fechado, mínimo, item indisponível...): HTTP 422. */
  | { status: "rejected"; errors: OrderErrorItem[] }
  /** Mesma chave de idempotência usada com outro conteúdo: HTTP 409. */
  | { status: "conflict" }
  /** Dados inválidos: HTTP 400. Campo -> mensagem. */
  | { status: "invalid"; issues: { path: string; message: string }[] }
  | { status: "not_found" }
  | { status: "error" };

/** Só os dígitos do telefone (formato enviado ao banco). */
export function phoneDigits(value: string): string {
  return onlyDigits(value);
}
