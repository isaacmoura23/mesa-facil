import { z } from "zod";

/** Schemas compartilhados entre o cliente (validação imediata) e o servidor (autoridade). */

const email = z
  .string()
  .trim()
  .min(1, "Informe seu e-mail.")
  .max(254, "E-mail muito longo.")
  .pipe(z.email("Informe um e-mail válido."));

export const loginSchema = z.object({
  email,
  password: z
    .string()
    .min(1, "Informe sua senha.")
    .max(256, "Senha muito longa."),
});

/** Mesma regra configurada no Supabase Auth (mínimo 10, com minúscula, maiúscula e número): o app avisa antes do servidor recusar. */
export const PASSWORD_MIN_LENGTH = 10;
export const PASSWORD_HINT = "Mínimo de 10 caracteres, com letras maiúsculas, minúsculas e números.";

function signupSchemaPassword() {
  return z
    .string()
    .min(PASSWORD_MIN_LENGTH, `A senha precisa ter pelo menos ${PASSWORD_MIN_LENGTH} caracteres.`)
    .max(256, "Senha muito longa.")
    .regex(/[a-z]/, "Use ao menos uma letra minúscula.")
    .regex(/[A-Z]/, "Use ao menos uma letra maiúscula.")
    .regex(/[0-9]/, "Use ao menos um número.");
}

export const signupSchema = z
  .object({
    fullName: z
      .string()
      .trim()
      .min(2, "Informe seu nome.")
      .max(120, "Nome muito longo."),
    email,
    password: signupSchemaPassword(),
    confirmPassword: z.string().min(1, "Repita a senha."),
  })
  .refine((value) => value.password === value.confirmPassword, {
    path: ["confirmPassword"],
    message: "As senhas não conferem.",
  });

export const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export const registerRestaurantSchema = z.object({
  name: z
    .string()
    .trim()
    .min(2, "Informe o nome do restaurante.")
    .max(120, "Nome muito longo (máximo de 120 caracteres)."),
  slug: z
    .string()
    .trim()
    .toLowerCase()
    .min(3, "O endereço precisa ter pelo menos 3 caracteres.")
    .max(63, "O endereço pode ter no máximo 63 caracteres.")
    .regex(
      SLUG_PATTERN,
      "Use apenas letras minúsculas, números e hífen (sem hífen no início ou no fim).",
    ),
});

export type FieldErrors = Record<string, string>;

/** Achata os issues do zod em { campo: primeira mensagem }. */
export function toFieldErrors(error: z.ZodError): FieldErrors {
  const result: FieldErrors = {};
  for (const issue of error.issues) {
    const key = String(issue.path[0] ?? "form");
    if (!(key in result)) result[key] = issue.message;
  }
  return result;
}

/** Gera um slug sugerido a partir do nome (remove acentos, espaços viram hífen). */
export function slugify(input: string): string {
  return input
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 63)
    .replace(/-+$/g, "");
}

export const forgotPasswordSchema = z.object({ email });

export const resetPasswordSchema = z
  .object({
    password: signupSchemaPassword(),
    confirmPassword: z.string().min(1, "Repita a senha."),
  })
  .refine((value) => value.password === value.confirmPassword, {
    path: ["confirmPassword"],
    message: "As senhas não conferem.",
  });

