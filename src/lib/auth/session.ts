import "server-only";
import { cache } from "react";
import { createClient } from "@/lib/supabase/server";
import type { AuthUser } from "./types";

/**
 * Usuário autenticado da requisição atual. Usa `auth.getClaims()`, que valida a
 * assinatura do JWT (JWKS) em vez de confiar no cookie, ao contrário de
 * `getSession()`, que NUNCA deve ser usado sozinho no servidor.
 */
export const getCurrentUser = cache(async (): Promise<AuthUser | null> => {
  const supabase = await createClient();
  const { data, error } = await supabase.auth.getClaims();
  if (error || !data) return null;

  const { claims } = data;
  if (!claims.sub) return null;

  const metadata: unknown = claims.user_metadata;
  const fullName =
    metadata && typeof metadata === "object" && "full_name" in metadata
      ? (metadata as { full_name?: unknown }).full_name
      : null;

  return {
    id: claims.sub,
    email: typeof claims.email === "string" ? claims.email : null,
    name: typeof fullName === "string" && fullName.trim() ? fullName.trim() : null,
  };
});
