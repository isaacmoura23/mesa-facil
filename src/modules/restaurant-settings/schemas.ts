import { z } from "zod";
import { parseToCents } from "@/lib/format";
import { TIME_PATTERN, toMinutes, validateWeek } from "./hours";
import { FULFILLMENT_TYPES } from "./types";

/**
 * Schemas de entrada das Server Actions de /app/[slug]/configuracoes. Valem no
 * navegador e no servidor. Nenhum recebe `restaurant_id`: vem do guard.
 */

export const PICKUP_INSTRUCTIONS_MAX = 300;
export const MAX_AMOUNT_CENTS = 10_000_000; // R$ 100.000,00
export const MAX_NEIGHBORHOODS = 100;
export const NEIGHBORHOOD_MAX = 80;

const idSchema = z.string().uuid("Registro inválido.");

/** Texto em reais -> centavos; vazio vale 0. */
function moneyField(label: string, maxCents: number = MAX_AMOUNT_CENTS) {
  return z
    .string()
    .optional()
    .transform((raw, ctx) => {
      const text = (raw ?? "").trim();
      if (text === "") return 0;
      const cents = parseToCents(text);
      if (cents === null || cents > maxCents) {
        ctx.addIssue({
          code: "custom",
          message: `${label}: informe um valor válido, como 25,00 (máximo ${(maxCents / 100).toLocaleString("pt-BR")}).`,
        });
        return z.NEVER;
      }
      return cents;
    });
}

/** Texto inteiro entre min e max; `optional` aceita vazio (vira null). */
function intField(label: string, min: number, max: number, unit: string) {
  return z.string().transform((raw, ctx) => {
    const text = raw.trim();
    if (!/^\d{1,6}$/.test(text) || Number(text) < min || Number(text) > max) {
      ctx.addIssue({ code: "custom", message: `${label}: informe ${unit} de ${min} a ${max}.` });
      return z.NEVER;
    }
    return Number(text);
  });
}

export const acceptsOrdersSchema = z.object({ acceptsOrders: z.boolean() });

export const rulesSchema = z.object({
  fulfillmentTypes: z
    .array(z.enum(FULFILLMENT_TYPES))
    .transform((list) => FULFILLMENT_TYPES.filter((type) => list.includes(type)))
    .pipe(z.array(z.enum(FULFILLMENT_TYPES)).min(1, "Habilite pelo menos uma modalidade.")),
  prepMinutes: intField("Tempo de preparo", 1, 600, "minutos"),
  minOrder: moneyField("Pedido mínimo"),
  pickupInstructions: z
    .string()
    .optional()
    .transform((value) => (value ?? "").trim())
    .pipe(
      z.string().max(PICKUP_INSTRUCTIONS_MAX, `Use no máximo ${PICKUP_INSTRUCTIONS_MAX} caracteres.`),
    )
    .transform((value) => (value === "" ? null : value)),
  singleTabPerTable: z.boolean(),
});
export type RulesInput = z.input<typeof rulesSchema>;

const timeSchema = z.string().regex(TIME_PATTERN, "Informe o horário no formato HH:MM.");

export const weekSchema = z
  .array(z.array(z.object({ opens: timeSchema, closes: timeSchema })).max(8))
  .length(7)
  .superRefine((week, ctx) => {
    const problem = validateWeek(week);
    if (problem) ctx.addIssue({ code: "custom", message: problem.message, path: [problem.weekday] });
  });

const dateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Informe a data.")
  .refine((value) => {
    const [year, month, day] = value.split("-").map(Number);
    const date = new Date(Date.UTC(year, month - 1, day));
    return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
  }, "Data inválida.");

export const exceptionSchema = z
  .object({
    id: idSchema.optional(),
    onDate: dateSchema,
    isClosed: z.boolean(),
    opensAt: z.string().optional(),
    closesAt: z.string().optional(),
    description: z
      .string()
      .optional()
      .transform((value) => (value ?? "").trim())
      .pipe(z.string().max(200, "Use no máximo 200 caracteres."))
      .transform((value) => (value === "" ? null : value)),
  })
  .superRefine((value, ctx) => {
    if (value.isClosed) return;
    const opens = value.opensAt ?? "";
    const closes = value.closesAt ?? "";
    if (!TIME_PATTERN.test(opens)) {
      ctx.addIssue({ code: "custom", path: ["opensAt"], message: "Informe a abertura." });
    }
    if (!TIME_PATTERN.test(closes)) {
      ctx.addIssue({ code: "custom", path: ["closesAt"], message: "Informe o fechamento." });
    }
    if (TIME_PATTERN.test(opens) && TIME_PATTERN.test(closes) && toMinutes(opens) === toMinutes(closes)) {
      ctx.addIssue({
        code: "custom",
        path: ["closesAt"],
        message: "A abertura e o fechamento não podem ser iguais.",
      });
    }
  })
  .transform((value) => ({
    id: value.id,
    onDate: value.onDate,
    isClosed: value.isClosed,
    opensAt: value.isClosed ? null : (value.opensAt ?? null),
    closesAt: value.isClosed ? null : (value.closesAt ?? null),
    description: value.description,
  }));

/** Bairros digitados (um por linha, ou separados por vírgula/ponto e vírgula). */
export function parseNeighborhoods(raw: string): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const part of raw.split(/[\n,;]+/)) {
    const name = part.trim().replace(/\s+/g, " ");
    if (name === "") continue;
    const key = name.toLocaleLowerCase("pt-BR");
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(name);
  }
  return result;
}

export const zoneSchema = z.object({
  id: idSchema.optional(),
  name: z
    .string()
    .transform((value) => value.trim())
    .pipe(z.string().min(1, "Informe o nome da região.").max(120, "Use no máximo 120 caracteres.")),
  fee: moneyField("Taxa de entrega", 100_000),
  minOrder: moneyField("Pedido mínimo"),
  estimatedMinutes: z
    .string()
    .optional()
    .transform((raw, ctx) => {
      const text = (raw ?? "").trim();
      if (text === "") return null;
      if (!/^\d{1,4}$/.test(text) || Number(text) < 1 || Number(text) > 1440) {
        ctx.addIssue({ code: "custom", message: "Tempo estimado: informe minutos de 1 a 1440." });
        return z.NEVER;
      }
      return Number(text);
    }),
  neighborhoods: z
    .string()
    .optional()
    .transform((raw, ctx) => {
      const list = parseNeighborhoods(raw ?? "");
      if (list.length > MAX_NEIGHBORHOODS) {
        ctx.addIssue({ code: "custom", message: `Use no máximo ${MAX_NEIGHBORHOODS} bairros.` });
        return z.NEVER;
      }
      if (list.some((name) => name.length > NEIGHBORHOOD_MAX)) {
        ctx.addIssue({
          code: "custom",
          message: `Cada bairro pode ter no máximo ${NEIGHBORHOOD_MAX} caracteres.`,
        });
        return z.NEVER;
      }
      return list;
    }),
  isActive: z.boolean(),
});

export const zoneToggleSchema = z.object({ id: idSchema, isActive: z.boolean() });
export const idOnlySchema = z.object({ id: idSchema });

/** Achata os issues do zod em { campo: primeira mensagem }. */
export function fieldErrorsOf(error: z.ZodError): Record<string, string> {
  const result: Record<string, string> = {};
  for (const issue of error.issues) {
    const key = issue.path.length > 0 ? issue.path.map(String).join(".") : "form";
    if (!(key in result)) result[key] = issue.message;
  }
  return result;
}
