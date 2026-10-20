import { z } from "zod";
import { SLUG_PATTERN, toFieldErrors } from "@/lib/validation/auth";
import { RESTAURANT_STATUSES } from "@/lib/auth/types";

export { toFieldErrors };

export const createRestaurantSchema = z.object({
  name: z
    .string()
    .trim()
    .min(2, "Informe o nome do restaurante (mínimo de 2 caracteres).")
    .max(120, "Nome muito longo (máximo de 120 caracteres)."),
  slug: z
    .string()
    .trim()
    .toLowerCase()
    .min(3, "O endereço precisa ter pelo menos 3 caracteres.")
    .max(63, "O endereço pode ter no máximo 63 caracteres.")
    .regex(SLUG_PATTERN, "Use apenas letras minúsculas, números e hífen (sem hífen no início ou no fim)."),
  ownerEmail: z
    .string()
    .trim()
    .toLowerCase()
    .min(1, "Informe o e-mail do dono.")
    .max(254, "E-mail muito longo.")
    .regex(/^[^@\s]+@[^@\s]+\.[^@\s]+$/, "Informe um e-mail válido, como nome@empresa.com."),
});

export const idSchema = z.uuid("Restaurante inválido. Atualize a página.");

export const suspendSchema = z.object({
  reason: z
    .string()
    .trim()
    .min(10, "Descreva o motivo com pelo menos 10 caracteres.")
    .max(500, "Motivo muito longo (máximo de 500 caracteres)."),
});

export const supportSessionSchema = z.object({
  reason: z
    .string()
    .trim()
    .min(10, "Descreva a justificativa com pelo menos 10 caracteres.")
    .max(500, "Justificativa muito longa (máximo de 500 caracteres)."),
  minutes: z.union([z.literal(15), z.literal(30), z.literal(60)], { error: "Escolha 15, 30 ou 60 minutos." }),
});

/** Parâmetros de URL da lista (tudo opcional e tolerante). */
export function parseListParams(raw: Record<string, string | string[] | undefined>): {
  q: string;
  status: (typeof RESTAURANT_STATUSES)[number] | "";
  cursor: Record<string, unknown> | null;
} {
  const one = (key: string): string => {
    const value = raw[key];
    return (Array.isArray(value) ? value[0] : value) ?? "";
  };
  const q = one("q").trim().slice(0, 80);
  const statusRaw = one("status");
  const status = (RESTAURANT_STATUSES as readonly string[]).includes(statusRaw)
    ? (statusRaw as (typeof RESTAURANT_STATUSES)[number])
    : "";
  return { q, status, cursor: decodeCursor(one("cursor")) };
}

export function encodeCursor(cursor: Record<string, unknown>): string {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

function decodeCursor(value: string): Record<string, unknown> | null {
  if (!value || value.length > 600) return null;
  try {
    const parsed: unknown = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}
