import { z } from "zod";
import { FULFILLMENTS, isUuid, type Fulfillment } from "./schemas";
import { isValidBrPhone, isValidCep } from "./masks";
import { MAX_LINES, MAX_NOTES, MAX_QUANTITY } from "./cart";

/**
 * Schemas do checkout, compartilhados entre o cliente (feedback imediato) e o
 * servidor (autoridade, em actions.ts). Nada aqui cria pedido.
 */

const optionalText = (max: number, message: string) =>
  z.string().trim().max(max, message);


export const checkoutFormSchema = z
  .object({
    fulfillment: z.enum(FULFILLMENTS, { error: "Escolha como quer receber o pedido." }),
    zoneId: z.string().trim(),
    name: z
      .string()
      .trim()
      .min(2, "Informe seu nome.")
      .max(80, "Nome muito longo (máximo de 80 caracteres)."),
    phone: z
      .string()
      .trim()
      .min(1, "Informe seu telefone.")
      .refine(isValidBrPhone, "Informe um telefone válido com DDD, ex.: (11) 91234-5678."),
    email: z
      .string()
      .trim()
      .max(254, "E-mail muito longo.")
      .refine((v) => v === "" || z.email().safeParse(v).success, "Informe um e-mail válido."),
    street: z.string().trim(),
    number: z.string().trim(),
    neighborhood: z.string().trim(),
    city: z.string().trim(),
    postalCode: z.string().trim(),
    complement: optionalText(120, "Complemento muito longo."),
    instructions: optionalText(300, "Instruções muito longas (máximo de 300 caracteres)."),
    notes: optionalText(500, "Observações muito longas (máximo de 500 caracteres)."),
  })
  .superRefine((value, ctx) => {
    if (value.fulfillment !== "DELIVERY") return;
    const required: [keyof typeof value, string, number][] = [
      ["street", "a rua", 160],
      ["number", "o nº", 20],
      ["neighborhood", "o bairro", 120],
      ["city", "a cidade", 120],
    ];
    for (const [field, label, max] of required) {
      const text = String(value[field]);
      if (!text) ctx.addIssue({ code: "custom", path: [field], message: `Informe ${label}.` });
      else if (text.length > max)
        ctx.addIssue({ code: "custom", path: [field], message: "Texto muito longo." });
    }
    if (!value.postalCode) {
      ctx.addIssue({ code: "custom", path: ["postalCode"], message: "Informe o CEP." });
    } else if (!isValidCep(value.postalCode)) {
      ctx.addIssue({
        code: "custom",
        path: ["postalCode"],
        message: "CEP inválido. Use 8 dígitos, ex.: 01310-100.",
      });
    }
    if (!isUuid(value.zoneId)) {
      ctx.addIssue({
        code: "custom",
        path: ["zoneId"],
        message: "Escolha a região de entrega.",
      });
    }
  });

export type CheckoutFormValues = z.input<typeof checkoutFormSchema>;
export type CheckoutFieldErrors = Partial<Record<keyof CheckoutFormValues, string>>;

export const EMPTY_CHECKOUT_FORM: CheckoutFormValues = {
  fulfillment: "PICKUP",
  zoneId: "",
  name: "",
  phone: "",
  email: "",
  street: "",
  number: "",
  neighborhood: "",
  city: "",
  postalCode: "",
  complement: "",
  instructions: "",
  notes: "",
};

/** Primeira mensagem por campo, a partir do resultado do zod. */
export function fieldErrorsFrom(error: z.ZodError): CheckoutFieldErrors {
  const out: CheckoutFieldErrors = {};
  for (const issue of error.issues) {
    const key = issue.path[0];
    if (typeof key === "string" && !(key in out)) {
      out[key as keyof CheckoutFormValues] = issue.message;
    }
  }
  return out;
}

/** Entrada da action de conferência de preços. */
export const cartQuoteInputSchema = z.object({
  slug: z.string().min(1).max(63),
  fulfillment: z.enum(FULFILLMENTS),
  zoneId: z
    .string()
    .nullable()
    .refine((v) => v === null || v === "" || isUuid(v), "zona inválida"),
  items: z
    .array(
      z.object({
        productId: z.string().refine(isUuid),
        variantId: z.string().refine(isUuid).nullable().optional(),
        quantity: z.number().int().min(1).max(MAX_QUANTITY),
        modifierIds: z.array(z.string().refine(isUuid)).max(60),
        notes: z.string().max(MAX_NOTES),
      }),
    )
    .max(MAX_LINES),
});

export type CartQuoteInput = z.infer<typeof cartQuoteInputSchema>;

export function fulfillmentNeedsAddress(fulfillment: Fulfillment): boolean {
  return fulfillment === "DELIVERY";
}
