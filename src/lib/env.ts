import { z } from "zod";

/**
 * Variáveis públicas (seguras para o navegador). A chave de service role NÃO
 * fica aqui: veja `env.server.ts`, protegido por `server-only`.
 *
 * Importante: o Next só inlina `process.env.NEXT_PUBLIC_*` quando a leitura é
 * literal, por isso cada variável é referenciada explicitamente abaixo.
 */
const publicEnvSchema = z.object({
  NEXT_PUBLIC_SUPABASE_URL: z.string().trim().pipe(z.url()),
  NEXT_PUBLIC_SUPABASE_ANON_KEY: z.string().trim().min(1),
  NEXT_PUBLIC_SITE_URL: z
    .string()
    .trim()
    .pipe(z.url())
    .optional()
    .or(z.literal("").transform(() => undefined)),
});

export type PublicEnv = {
  supabaseUrl: string;
  supabaseAnonKey: string;
  /** URL pública do app (opcional). Usada nos links de e-mail do Supabase. */
  siteUrl: string | null;
};

export type PublicEnvStatus =
  | { ok: true; env: PublicEnv }
  | { ok: false; invalid: string[] };

export class SupabaseNotConfiguredError extends Error {
  constructor(public readonly invalid: string[]) {
    super(
      `Supabase não configurado. Variáveis ausentes ou inválidas: ${invalid.join(", ")}`,
    );
    this.name = "SupabaseNotConfiguredError";
  }
}

/** Valida as variáveis públicas sem lançar. Nunca inclui valores na resposta. */
export function getPublicEnvStatus(): PublicEnvStatus {
  const parsed = publicEnvSchema.safeParse({
    NEXT_PUBLIC_SUPABASE_URL: process.env.NEXT_PUBLIC_SUPABASE_URL ?? "",
    NEXT_PUBLIC_SUPABASE_ANON_KEY:
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "",
    NEXT_PUBLIC_SITE_URL: process.env.NEXT_PUBLIC_SITE_URL ?? "",
  });

  if (!parsed.success) {
    const invalid = Array.from(
      new Set(parsed.error.issues.map((issue) => String(issue.path[0]))),
    );
    return { ok: false, invalid };
  }

  return {
    ok: true,
    env: {
      supabaseUrl: parsed.data.NEXT_PUBLIC_SUPABASE_URL,
      supabaseAnonKey: parsed.data.NEXT_PUBLIC_SUPABASE_ANON_KEY,
      siteUrl: parsed.data.NEXT_PUBLIC_SITE_URL ?? null,
    },
  };
}

export function isSupabaseConfigured(): boolean {
  return getPublicEnvStatus().ok;
}

/** Retorna o ambiente público ou lança `SupabaseNotConfiguredError`. */
export function requirePublicEnv(): PublicEnv {
  const status = getPublicEnvStatus();
  if (!status.ok) throw new SupabaseNotConfiguredError(status.invalid);
  return status.env;
}
