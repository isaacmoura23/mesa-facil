import { z } from "zod";
import { parseToCents } from "@/lib/format";
import { MAX_BADGES, isProductBadge, type ProductBadge } from "./badges";

/**
 * Schemas de entrada do cardápio. São usados no navegador (validação imediata)
 * e no servidor (autoridade). Os campos chegam como texto de formulário.
 * Nenhum schema recebe `restaurant_id`: o restaurante sempre vem do guard.
 */

/** Preço máximo aceito: R$ 99.999,99 (bem abaixo do limite do inteiro do banco). */
export const MAX_PRICE_CENTS = 9_999_999;
export const MAX_GROUP_SELECTIONS = 50;
/** Tamanhos por produto (limite de interface; o banco não impõe um teto). */
export const MAX_VARIANTS = 10;
/** CHECK product_variants_name_len. */
export const VARIANT_NAME_MAX = 40;

const idSchema = z.uuid("Identificador inválido. Atualize a página e tente de novo.");

/** "" vira `undefined`; qualquer outro valor precisa ser um UUID. */
const optionalId = z
  .string()
  .trim()
  .transform((value) => (value === "" ? undefined : value))
  .pipe(idSchema.optional());

/** "" vira `null`; qualquer outro valor precisa ser um UUID. */
const nullableId = z
  .string()
  .trim()
  .transform((value) => (value === "" ? null : value))
  .pipe(idSchema.nullable());

const optionalText = (max: number, message: string) =>
  z
    .string()
    .trim()
    .max(max, message)
    .transform((value) => (value === "" ? null : value));

const boolField = z.enum(["true", "false"]).transform((value) => value === "true");

type PriceParse = { ok: true; cents: number } | { ok: false; message: string };

/** Texto de preço ("25,90") -> centavos, com mensagens PT-BR. Vazio é erro. */
export function parsePriceText(value: string): PriceParse {
  const text = value.trim();
  if (text === "") return { ok: false, message: "Informe o preço." };
  const cents = parseToCents(text);
  if (cents === null) return { ok: false, message: "Preço inválido. Use o formato 25,90." };
  if (cents > MAX_PRICE_CENTS) {
    return { ok: false, message: "Preço muito alto (máximo R$ 99.999,99)." };
  }
  return { ok: true, cents };
}

function priceField(options: { required: boolean }) {
  return z
    .string()
    .trim()
    .transform((value, ctx) => {
      if (value === "" && !options.required) return 0;
      const parsed = parsePriceText(value);
      if (!parsed.ok) {
        ctx.addIssue({ code: "custom", message: parsed.message });
        return z.NEVER;
      }
      return parsed.cents;
    });
}

export const slugSchema = z.string().trim().min(1).max(63);

export const categorySchema = z.object({
  id: optionalId,
  name: z
    .string()
    .trim()
    .min(1, "Informe o nome da categoria.")
    .max(120, "Nome muito longo (máximo de 120 caracteres)."),
  description: optionalText(500, "Descrição muito longa (máximo de 500 caracteres)."),
});
export type CategoryInput = z.infer<typeof categorySchema>;

// ---------------------------------------------------------------------------
// Tamanhos (variantes)
// ---------------------------------------------------------------------------

export const variantInputSchema = z.object({
  id: optionalId,
  name: z
    .string()
    .trim()
    .min(1, "Informe o nome do tamanho.")
    .max(VARIANT_NAME_MAX, `Nome muito longo (máximo de ${VARIANT_NAME_MAX} caracteres).`),
  price: priceField({ required: true }),
  isDefault: z.boolean(),
  isAvailable: z.boolean(),
});
export type VariantInput = z.infer<typeof variantInputSchema>;

const variantListSchema = z
  .array(variantInputSchema)
  .max(MAX_VARIANTS, `Use no máximo ${MAX_VARIANTS} tamanhos por produto.`)
  .superRefine((list, ctx) => {
    const seen = new Map<string, number>();
    list.forEach((variant, index) => {
      const key = variant.name.toLocaleLowerCase("pt-BR");
      if (key === "") return;
      if (seen.has(key)) {
        ctx.addIssue({
          code: "custom",
          path: [index, "name"],
          message: "Já existe um tamanho com esse nome neste produto.",
        });
      }
      seen.set(key, index);
    });
    if (list.length > 0 && list.filter((variant) => variant.isDefault).length !== 1) {
      ctx.addIssue({
        code: "custom",
        message: "Marque exatamente um tamanho como padrão.",
      });
    }
  });

/**
 * Lista de tamanhos enviada como JSON no campo `variants` do formulário.
 * Os erros saem com caminho `variants.<índice>.<campo>` (ver `fieldErrorsOf`).
 */
const variantsField = z
  .string()
  .optional()
  .transform((raw, ctx): VariantInput[] => {
    if (raw === undefined || raw.trim() === "") return [];
    let json: unknown;
    try {
      json = JSON.parse(raw);
    } catch {
      ctx.addIssue({ code: "custom", message: "Lista de tamanhos inválida. Atualize a página." });
      return z.NEVER;
    }
    const result = variantListSchema.safeParse(json);
    if (!result.success) {
      for (const issue of result.error.issues) {
        ctx.addIssue({ code: "custom", message: issue.message, path: issue.path });
      }
      return z.NEVER;
    }
    return result.data;
  });

/** Selos separados por vírgula no campo `badges`. */
const badgesField = z
  .string()
  .optional()
  .transform((raw, ctx): ProductBadge[] => {
    const items = (raw ?? "")
      .split(",")
      .map((item) => item.trim())
      .filter((item) => item !== "");
    const result: ProductBadge[] = [];
    for (const item of items) {
      if (!isProductBadge(item)) {
        ctx.addIssue({ code: "custom", message: "Selo inválido." });
        return z.NEVER;
      }
      if (!result.includes(item)) result.push(item);
    }
    if (result.length > MAX_BADGES) {
      ctx.addIssue({ code: "custom", message: `Escolha no máximo ${MAX_BADGES} selos.` });
      return z.NEVER;
    }
    return result;
  });

export const productSchema = z
  .object({
    id: optionalId,
    name: z
      .string()
      .trim()
      .min(1, "Informe o nome do produto.")
      .max(160, "Nome muito longo (máximo de 160 caracteres)."),
    description: optionalText(1000, "Descrição muito longa (máximo de 1000 caracteres)."),
    /** Texto bruto; é obrigatório só quando o produto não tem tamanhos. */
    price: z
      .string()
      .optional()
      .transform((value) => (value ?? "").trim()),
    variants: variantsField,
    badges: badgesField,
    categoryId: nullableId,
    isActive: boolField,
    isAvailable: boolField,
  })
  .transform((value, ctx) => {
    let price: number | null = null;
    if (value.variants.length === 0) {
      const parsed = parsePriceText(value.price);
      if (!parsed.ok) {
        ctx.addIssue({ code: "custom", path: ["price"], message: parsed.message });
        return z.NEVER;
      }
      price = parsed.cents;
    }
    // Com tamanhos, o preço do produto (sem tamanho) não é digitado: `price` fica null.
    return { ...value, price };
  });
export type ProductInput = z.infer<typeof productSchema>;

export const groupIdsSchema = z.array(idSchema).max(200, "Seleção grande demais.");

const selectionCount = (max: number, label: string) =>
  z
    .string()
    .trim()
    .regex(/^\d+$/, `${label}: informe um número inteiro.`)
    .transform(Number)
    .pipe(z.number().max(max, `${label}: máximo de ${max}.`));

export const modifierGroupSchema = z
  .object({
    id: optionalId,
    name: z
      .string()
      .trim()
      .min(1, "Informe o nome do grupo.")
      .max(120, "Nome muito longo (máximo de 120 caracteres)."),
    min: selectionCount(MAX_GROUP_SELECTIONS, "Mínimo"),
    max: selectionCount(MAX_GROUP_SELECTIONS, "Máximo").pipe(
      z.number().min(1, "O máximo precisa ser pelo menos 1."),
    ),
  })
  .refine((value) => value.min <= value.max, {
    path: ["min"],
    message: "O mínimo não pode ser maior que o máximo.",
  });
export type ModifierGroupInput = z.infer<typeof modifierGroupSchema>;

export const modifierSchema = z.object({
  id: optionalId,
  groupId: idSchema,
  name: z
    .string()
    .trim()
    .min(1, "Informe o nome do item.")
    .max(120, "Nome muito longo (máximo de 120 caracteres)."),
  price: priceField({ required: false }),
  isAvailable: boolField,
});
export type ModifierInput = z.infer<typeof modifierSchema>;

export const reorderSchema = z.object({
  kind: z.enum(["category", "product", "modifier_group", "modifier"]),
  ids: z
    .array(idSchema)
    .min(1, "Nada para reordenar.")
    .max(500, "Lista grande demais.")
    .refine((ids) => new Set(ids).size === ids.length, "Lista com itens repetidos."),
});

export const entityIdSchema = idSchema;

/** Caminho no Storage informado pelo formulário (a regra fina fica em image.ts). */
export const imagePathSchema = z
  .string()
  .trim()
  .max(500)
  .transform((value) => (value === "" ? null : value));

/** Converte FormData em { campo: texto }, ignorando arquivos. */
export function formToRecord(formData: FormData): Record<string, string> {
  const record: Record<string, string> = {};
  for (const [key, value] of formData.entries()) {
    if (typeof value === "string") record[key] = value;
  }
  return record;
}

/**
 * Achata os issues do zod em { campo: primeira mensagem }. Caminhos aninhados
 * viram chaves com ponto (ex.: `variants.0.name`).
 */
export function fieldErrorsOf(error: z.ZodError): Record<string, string> {
  const result: Record<string, string> = {};
  for (const issue of error.issues) {
    const key = issue.path.length > 0 ? issue.path.map(String).join(".") : "form";
    if (!(key in result)) result[key] = issue.message;
  }
  return result;
}
