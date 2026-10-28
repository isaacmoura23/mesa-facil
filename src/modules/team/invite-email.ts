import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import { getPublicEnvStatus } from "@/lib/env";

/**
 * E-mail de convite de equipe (SERVIDOR). O vínculo já foi criado pela RPC `invite_member`; aqui só
 * tentamos avisar a pessoa por e-mail com `auth.admin.inviteUserByEmail` (service role).
 *
 * - O resultado devolvido ao dono é NEUTRO (não diz se a conta já existia): o dono não enumera contas.
 * - Falha de SMTP/serviço NÃO desfaz o convite: o chamador mostra um aviso para a pessoa se cadastrar sozinha.
 * - O link do e-mail cai em /auth/callback?next=/redefinir-senha (a pessoa define a senha e depois aceita o convite
 *   em /entrar). A origem sai de NEXT_PUBLIC_SITE_URL, nunca do cabeçalho Host (S-07).
 */

export type InviteEmailResult = "dispatched" | "failed";

export async function sendInviteEmail(email: string): Promise<InviteEmailResult> {
  try {
    const status = getPublicEnvStatus();
    const origin = status.ok && status.env.siteUrl ? status.env.siteUrl.replace(/[/]$/, "") : null;
    const admin = createAdminClient();
    const { error } = await admin.auth.admin.inviteUserByEmail(email, {
      redirectTo: origin ? `${origin}/auth/callback?next=/redefinir-senha` : undefined,
    });
    if (!error) return "dispatched";
    // Conta já existente: a pessoa vê o convite ao entrar; não é falha nem é informado ao dono.
    if (error.code === "email_exists" || error.status === 422) return "dispatched";
    console.error("[team] inviteUserByEmail:", error.code ?? error.status ?? "erro");
    return "failed";
  } catch (error) {
    console.error("[team] inviteUserByEmail:", error instanceof Error ? error.name : "erro");
    return "failed";
  }
}
