import { z } from "zod";
import { isValidTimezone } from "./timezones";
import {
  ADDRESS_MAX,
  normalizePhone,
  normalizeStorefrontUrl,
  normalizeWhatsapp,
  type Normalized,
} from "./format";

/**
 * Schemas de entrada de /app/[slug]/restaurante. Usados no navegador e no
 * servidor. Nenhum recebe `restaurant_id`: o restaurante vem do guard.
 */

export const slugSchema = z.string().trim().min(1).max(63);

/** Aplica um normalizador ao texto do campo e converte a falha em issue do zod. */
function normalizedField<T>(normalize: (raw: string) => Normalized<T>) {
  return z
    .string()
    .optional()
    .transform((raw, ctx) => {
      const result = normalize(raw ?? "");
      if (!result.ok) {
        ctx.addIssue({ code: "custom", message: result.message });
        return z.NEVER;
      }
      return result.value;
    });
}

export const contactSchema = z.object({
  whatsapp: normalizedField(normalizeWhatsapp),
  phone: normalizedField(normalizePhone),
  addressText: z
    .string()
    .optional()
    .transform((value) => (value ?? "").trim())
    .pipe(z.string().max(ADDRESS_MAX, `Endereço muito longo (máximo de ${ADDRESS_MAX} caracteres).`))
    .transform((value) => (value === "" ? null : value)),
  storefrontUrl: normalizedField(normalizeStorefrontUrl),
});
export type ContactInput = z.infer<typeof contactSchema>;

export const originsInputSchema = z.array(z.string().max(255)).max(20);

/** Converte FormData em { campo: texto }, ignorando arquivos. */
export function formToRecord(formData: FormData): Record<string, string> {
  const record: Record<string, string> = {};
  for (const [key, value] of formData.entries()) {
    if (typeof value === "string") record[key] = value;
  }
  return record;
}

/** Achata os issues do zod em { campo: primeira mensagem }. */
export function fieldErrorsOf(error: z.ZodError): Record<string, string> {
  const result: Record<string, string> = {};
  for (const issue of error.issues) {
    const key = issue.path.length > 0 ? issue.path.map(String).join(".") : "form";
    if (!(key in result)) result[key] = issue.message;
  }
  return result;
}

export const NAME_MIN = 2;
export const NAME_MAX = 120;

/** Dados do estabelecimento. `logoPath` é o arquivo já enviado ao Storage (ou null). */
export const establishmentSchema = z.object({
  name: z
    .string()
    .transform((value) => value.trim().replace(/\s+/g, " "))
    .pipe(
      z
        .string()
        .min(NAME_MIN, `Informe o nome (mínimo de ${NAME_MIN} caracteres).`)
        .max(NAME_MAX, `Nome muito longo (máximo de ${NAME_MAX} caracteres).`),
    ),
  timezone: z.string().refine(isValidTimezone, "Escolha um fuso horário válido."),
  logoPath: z.string().max(300).nullable(),
  removeLogo: z.boolean(),
});
export type EstablishmentInput = z.input<typeof establishmentSchema>;
