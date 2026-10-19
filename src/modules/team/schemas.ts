import { z } from "zod";
import { ASSIGNABLE_ROLES } from "./types";
import { PERMISSIONS } from "@/lib/auth/types";

export const slugSchema = z.string().trim().min(1).max(80);
export const membershipIdSchema = z.uuid("Integrante inválido. Atualize a página e tente de novo.");

export const inviteSchema = z.object({
  email: z
    .string()
    .trim()
    .toLowerCase()
    .min(1, "Informe o e-mail da pessoa.")
    .max(254, "E-mail muito longo.")
    .regex(/^[^@\s]+@[^@\s]+\.[^@\s]+$/, "Informe um e-mail válido, como nome@empresa.com."),
  role: z.enum(ASSIGNABLE_ROLES, { error: "Escolha uma função." }),
});

export const roleSchema = z.enum(ASSIGNABLE_ROLES, { error: "Escolha uma função." });

export const permissionSchema = z.enum(PERMISSIONS, { error: "Permissão desconhecida." });

const dateSchema = z.union([z.literal(""), z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Data inválida.")]);

export const auditFiltersSchema = z.object({
  category: z.string().max(40),
  from: dateSchema,
  to: dateSchema,
});

export function fieldErrorsOf(error: z.ZodError): Record<string, string> {
  const out: Record<string, string> = {};
  for (const issue of error.issues) {
    const key = String(issue.path[0] ?? "form");
    if (!(key in out)) out[key] = issue.message;
  }
  return out;
}
