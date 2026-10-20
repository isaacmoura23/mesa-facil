import { z } from "zod";
import { parseToCents } from "@/lib/format";

/** Validação compartilhada (cliente e servidor). Sem `server-only`. */

export const SUBSCRIPTION_STATUSES = ["trial", "active", "past_due", "cancelled"] as const;
export const TICKET_STATUSES = ["open", "in_progress", "resolved", "closed"] as const;

export const LIMIT_KEYS = [
  { key: "max_members", label: "Máx. de integrantes" },
  { key: "max_tables", label: "Máx. de mesas" },
  { key: "max_products", label: "Máx. de produtos" },
] as const;

const uuid = z.uuid("Identificador inválido. Atualize a página e tente de novo.");
const ymd = z.union([z.literal(""), z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Data inválida.")]);

export function fieldErrorsOf(error: z.ZodError): Record<string, string> {
  const out: Record<string, string> = {};
  for (const issue of error.issues) {
    const key = String(issue.path[0] ?? "form");
    if (!(key in out)) out[key] = issue.message;
  }
  return out;
}

/** "chave" -> true; "chave=valor" -> valor (true/false/número/texto). */
export function parseFeatureLines(text: string): Record<string, unknown> | null {
  const out: Record<string, unknown> = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const eq = line.indexOf("=");
    const key = (eq === -1 ? line : line.slice(0, eq)).trim();
    if (!/^[a-z0-9_]{1,40}$/.test(key)) return null;
    const value = eq === -1 ? "true" : line.slice(eq + 1).trim();
    if (value === "true") out[key] = true;
    else if (value === "false") out[key] = false;
    else if (/^-?\d+(\.\d+)?$/.test(value)) out[key] = Number(value);
    else if (value.length > 0 && value.length <= 60) out[key] = value;
    else return null;
  }
  return out;
}

export function featuresToLines(features: Record<string, unknown>): string {
  return Object.entries(features)
    .map(([key, value]) => (value === true ? key : `${key}=${String(value)}`))
    .join("\n");
}

const limitField = z
  .string()
  .trim()
  .refine((value) => value === "" || /^\d{1,9}$/.test(value), "Use um número inteiro maior ou igual a zero, ou deixe vazio para ilimitado.");

export const planFormSchema = z.object({
  id: z.union([z.literal(""), uuid]),
  code: z
    .string()
    .trim()
    .regex(/^[a-z0-9-]{2,40}$/, "Use de 2 a 40 letras minúsculas, números ou hífen."),
  name: z.string().trim().min(2, "Informe o nome do plano.").max(80, "Nome muito longo."),
  price: z.string().refine((value) => parseToCents(value) !== null, "Informe um preço válido, como 99,90."),
  max_members: limitField,
  max_tables: limitField,
  max_products: limitField,
  features: z.string().max(2000, "Lista muito longa.").refine(
    (value) => parseFeatureLines(value) !== null,
    "Uma linha por recurso: 'chave' (ativo) ou 'chave=valor'. Use letras minúsculas, números e sublinhado.",
  ),
  isActive: z.boolean(),
});
export type PlanFormInput = z.input<typeof planFormSchema>;

export const subscriptionFormSchema = z.object({
  restaurant: uuid,
  plan: uuid,
  status: z.enum(SUBSCRIPTION_STATUSES, { error: "Escolha o estado da assinatura." }),
  periodEnd: ymd,
  note: z.string().trim().max(500, "Use até 500 caracteres.").optional().default(""),
});
export type SubscriptionFormInput = z.input<typeof subscriptionFormSchema>;

export const ticketFormSchema = z.object({
  id: uuid,
  status: z.enum(TICKET_STATUSES, { error: "Escolha o estado do ticket." }),
  note: z.string().trim().max(1000, "Use até 1000 caracteres.").optional().default(""),
});
export type TicketFormInput = z.input<typeof ticketFormSchema>;

export const sessionIdSchema = uuid;

export const settingsFormSchema = z.object({
  registrationEnabled: z.boolean(),
  defaultTrialDays: z
    .string()
    .trim()
    .regex(/^\d{1,3}$/, "Informe um número inteiro de 0 a 365.")
    .refine((value) => Number(value) <= 365, "O período de teste vai até 365 dias."),
  supportEmail: z
    .string()
    .trim()
    .max(200, "Use até 200 caracteres.")
    .refine((value) => value === "" || /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(value), "Informe um e-mail válido."),
  maintenanceMessage: z.string().trim().max(300, "Use até 300 caracteres."),
});
export type SettingsFormInput = z.input<typeof settingsFormSchema>;

export const auditFiltersSchema = z.object({
  actor: z.union([z.literal(""), uuid]),
  prefix: z.string().trim().max(60).regex(/^[a-z0-9_.]*$/, "Use só letras minúsculas, números, ponto e sublinhado."),
  restaurant: z.union([z.literal(""), uuid]),
  from: ymd,
  to: ymd,
});

export const subscriptionFilterSchema = z.enum(["", ...SUBSCRIPTION_STATUSES]);
export const ticketFilterSchema = z.enum(["", ...TICKET_STATUSES]);
