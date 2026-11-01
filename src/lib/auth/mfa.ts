import "server-only";
import { createClient } from "@/lib/supabase/server";

/**
 * MFA TOTP (Supabase). Para `platform_admins` o nível aal2 é OBRIGATÓRIO em produção.
 *
 * `PLATFORM_REQUIRE_MFA`: "true"/"1" liga; "false"/"0" desliga; ausente => ligado em produção e desligado
 * em desenvolvimento (para não quebrar os testes E2E, que entram só com senha).
 */
export function isPlatformMfaRequired(env: Record<string, string | undefined> = process.env): boolean {
  const value = env.PLATFORM_REQUIRE_MFA?.trim().toLowerCase();
  if (value === "true" || value === "1") return true;
  if (value === "false" || value === "0") return false;
  return env.NODE_ENV === "production";
}

export type MfaState = {
  /** A sessão atual já passou pelo segundo fator (claim `aal` do JWT validado). */
  aal2: boolean;
  /** O usuário tem pelo menos um fator TOTP verificado. */
  hasVerifiedTotp: boolean;
};

export type TotpFactor = { id: string; friendlyName: string | null; createdAt: string };

export type MfaFactors = {
  verified: TotpFactor[];
  /** Cadastros iniciados e nunca confirmados (lixo a limpar antes de um novo cadastro). */
  unverified: TotpFactor[];
};

export async function getMfaFactors(): Promise<MfaFactors> {
  const supabase = await createClient();
  const { data, error } = await supabase.auth.mfa.listFactors();
  if (error || !data) return { verified: [], unverified: [] };
  const toFactor = (f: { id: string; friendly_name?: string; created_at: string }): TotpFactor => ({
    id: f.id,
    friendlyName: f.friendly_name ?? null,
    createdAt: f.created_at,
  });
  const verified = data.totp.map(toFactor);
  const unverified = data.all.filter((f) => f.factor_type === "totp" && f.status === "unverified").map(toFactor);
  return { verified, unverified };
}

export async function getMfaState(): Promise<MfaState> {
  const supabase = await createClient();
  const [claims, factors] = await Promise.all([supabase.auth.getClaims(), getMfaFactors()]);
  const aal = claims.data?.claims && "aal" in claims.data.claims ? claims.data.claims.aal : undefined;
  return { aal2: aal === "aal2", hasVerifiedTotp: factors.verified.length > 0 };
}
