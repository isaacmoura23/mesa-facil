import "server-only";
import { z } from "zod";

const serverEnvSchema = z.object({
  SUPABASE_SERVICE_ROLE_KEY: z.string().trim().min(1),
});

/**
 * Chave de service role. Só existe em código de servidor (`server-only`
 * quebra o build se este módulo for importado por um Client Component).
 * Ela ignora RLS: use apenas em rotinas administrativas explicitamente
 * autorizadas, nunca com dados vindos do cliente sem validação.
 */
export function getServiceRoleKey(): string {
  const parsed = serverEnvSchema.safeParse({
    SUPABASE_SERVICE_ROLE_KEY: process.env.SUPABASE_SERVICE_ROLE_KEY ?? "",
  });
  if (!parsed.success) {
    throw new Error(
      "SUPABASE_SERVICE_ROLE_KEY não configurada (necessária apenas para operações administrativas no servidor).",
    );
  }
  return parsed.data.SUPABASE_SERVICE_ROLE_KEY;
}
