"use server";

import { revalidatePath } from "next/cache";
import { requireRestaurantAccess } from "@/lib/auth/guards";
import { GENERIC_ERROR_MESSAGE, RPC_ERROR_MESSAGES, rpcErrorMessage } from "@/lib/errors";
import { getPublicEnvStatus } from "@/lib/env";
import { createClient } from "@/lib/supabase/server";
import type { AppSupabaseClient } from "@/lib/supabase/types";
import { getAuditPage, getTeam } from "./queries";
import {
  auditFiltersSchema,
  fieldErrorsOf,
  inviteSchema,
  membershipIdSchema,
  permissionSchema,
  roleSchema,
  slugSchema,
} from "./schemas";
import { auditCursorSchema, type ActionResult, type AuditCursor, type AuditFilters, type AuditResult } from "./types";

/**
 * Server Actions de equipe. Toda ação resolve o restaurante pelo guard
 * (`team.manage`, só o proprietário) a partir do slug; nenhum `restaurant_id`
 * vem do cliente. As escritas usam o cliente Supabase do usuário e as RPCs
 * revalidam permissão e regras (owner protegido, sem autoalteração).
 */

type Context = { restaurantId: string; slug: string; supabase: AppSupabaseClient };
type Failure = Extract<ActionResult, { ok: false }>;
type Authorization = { ok: true; ctx: Context } | { ok: false; result: Failure };

const NOT_CONFIGURED: Failure = { ok: false, message: "O Supabase ainda não está configurado neste ambiente." };

const NO_EMAIL_NOTICE =
  "Nenhum e-mail é enviado. Peça para a pessoa se cadastrar em /entrar com este e-mail e aceitar o convite.";

const EXTRA_MESSAGES: Record<string, string> = {
  invalid_granted: "Valor de permissão inválido.",
};

async function authorize(slug: string): Promise<Authorization> {
  if (!getPublicEnvStatus().ok) return { ok: false, result: NOT_CONFIGURED };
  const parsedSlug = slugSchema.safeParse(slug);
  if (!parsedSlug.success) return { ok: false, result: { ok: false, message: "Restaurante inválido." } };
  const access = await requireRestaurantAccess(parsedSlug.data, { area: "app", permission: "team.manage" });
  const supabase = await createClient();
  return {
    ok: true,
    ctx: { restaurantId: access.restaurant.restaurant_id, slug: access.restaurant.slug, supabase },
  };
}

type DbError = { message?: string; code?: string } | null | undefined;

/** Erros do banco -> PT-BR. Mensagens cruas nunca saem daqui. */
function failure(error: DbError): Failure {
  const code = error?.code;
  if (code === "PGRST301" || code === "PGRST303") return { ok: false, message: RPC_ERROR_MESSAGES.not_authenticated };
  const extra = Object.keys(EXTRA_MESSAGES).find((key) => error?.message?.includes(key));
  if (extra) return { ok: false, message: EXTRA_MESSAGES[extra] };
  if (code === "PGRST202" || code === "42883") {
    return { ok: false, message: "Esta operação ainda não está disponível neste ambiente." };
  }
  if (code === "42501" && !error?.message?.trim()) return { ok: false, message: RPC_ERROR_MESSAGES.forbidden };
  return { ok: false, message: rpcErrorMessage(error, GENERIC_ERROR_MESSAGE) };
}

function revalidateTeam(ctx: Context): void {
  revalidatePath(`/app/${ctx.slug}/equipe`);
}

export async function inviteMemberAction(slug: string, input: { email: string; role: string }): Promise<ActionResult> {
  const auth = await authorize(slug);
  if (!auth.ok) return auth.result;
  const parsed = inviteSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, message: "Revise os campos destacados.", fieldErrors: fieldErrorsOf(parsed.error) };
  }
  const { ctx } = auth;
  const { error } = await ctx.supabase.rpc("invite_member", {
    p_restaurant: ctx.restaurantId,
    p_email: parsed.data.email,
    p_role: parsed.data.role,
  });
  if (error) return failure(error);
  revalidateTeam(ctx);
  return { ok: true, message: `Convite registrado para ${parsed.data.email}`, warning: NO_EMAIL_NOTICE };
}

/** Renova um convite pendente ou convida de novo quem teve o acesso revogado. */
export async function resendInviteAction(slug: string, membershipId: string): Promise<ActionResult> {
  const auth = await authorize(slug);
  if (!auth.ok) return auth.result;
  const id = membershipIdSchema.safeParse(membershipId);
  if (!id.success) return { ok: false, message: id.error.issues[0].message };
  const { ctx } = auth;

  const team = await getTeam(ctx.restaurantId);
  if (!team.ok) return { ok: false, message: team.message };
  const member = team.members.find((item) => item.membership_id === id.data);
  const email = member?.invited_email ?? member?.email ?? null;
  if (!member || member.status === "active" || member.role === "owner" || !email) {
    return { ok: false, message: "Este convite não está mais disponível. Atualize a página." };
  }

  const { error } = await ctx.supabase.rpc("invite_member", {
    p_restaurant: ctx.restaurantId,
    p_email: email,
    p_role: member.role,
  });
  if (error) return failure(error);
  revalidateTeam(ctx);
  return { ok: true, message: "Convite renovado", warning: NO_EMAIL_NOTICE };
}

export async function changeMemberRoleAction(slug: string, membershipId: string, role: string): Promise<ActionResult> {
  const auth = await authorize(slug);
  if (!auth.ok) return auth.result;
  const id = membershipIdSchema.safeParse(membershipId);
  const parsedRole = roleSchema.safeParse(role);
  if (!id.success || !parsedRole.success) {
    return { ok: false, message: "Dados inválidos. Atualize a página e tente de novo." };
  }
  const { ctx } = auth;
  const { error } = await ctx.supabase.rpc("change_member_role", { p_membership: id.data, p_role: parsedRole.data });
  if (error) return failure(error);
  revalidateTeam(ctx);
  return { ok: true, message: "Função atualizada. As permissões voltaram ao padrão da nova função." };
}

/** Revoga o acesso de um integrante ativo ou cancela um convite pendente. */
export async function revokeMemberAction(slug: string, membershipId: string): Promise<ActionResult> {
  const auth = await authorize(slug);
  if (!auth.ok) return auth.result;
  const id = membershipIdSchema.safeParse(membershipId);
  if (!id.success) return { ok: false, message: id.error.issues[0].message };
  const { ctx } = auth;
  const { error } = await ctx.supabase.rpc("revoke_member", { p_membership: id.data });
  if (error) return failure(error);
  revalidateTeam(ctx);
  return { ok: true, message: "Acesso revogado" };
}

export async function setMemberPermissionAction(
  slug: string,
  membershipId: string,
  permission: string,
  granted: boolean,
): Promise<ActionResult> {
  const auth = await authorize(slug);
  if (!auth.ok) return auth.result;
  const id = membershipIdSchema.safeParse(membershipId);
  const perm = permissionSchema.safeParse(permission);
  if (!id.success || !perm.success || typeof granted !== "boolean") {
    return { ok: false, message: "Dados inválidos. Atualize a página e tente de novo." };
  }
  const { ctx } = auth;
  const { error } = await ctx.supabase.rpc("set_member_permission", {
    p_membership: id.data,
    p_permission: perm.data,
    p_granted: granted,
  });
  if (error) return failure(error);
  revalidateTeam(ctx);
  return { ok: true };
}

/**
 * Remove todos os overrides do integrante. O padrão do papel é derivado no
 * servidor (inverso de cada override), nunca informado pelo cliente.
 */
export async function resetMemberPermissionsAction(slug: string, membershipId: string): Promise<ActionResult> {
  const auth = await authorize(slug);
  if (!auth.ok) return auth.result;
  const id = membershipIdSchema.safeParse(membershipId);
  if (!id.success) return { ok: false, message: id.error.issues[0].message };
  const { ctx } = auth;

  const team = await getTeam(ctx.restaurantId);
  if (!team.ok) return { ok: false, message: team.message };
  const member = team.members.find((item) => item.membership_id === id.data);
  if (!member) return { ok: false, message: "Integrante não encontrado. Atualize a página." };

  for (const override of member.overrides) {
    const { error } = await ctx.supabase.rpc("set_member_permission", {
      p_membership: id.data,
      p_permission: override.permission,
      p_granted: !override.granted,
    });
    if (error) {
      revalidateTeam(ctx);
      return failure(error);
    }
  }
  revalidateTeam(ctx);
  return { ok: true, message: "Permissões voltaram ao padrão da função" };
}

export async function loadAuditLogsAction(
  slug: string,
  filters: AuditFilters,
  before: AuditCursor | null,
): Promise<AuditResult> {
  const auth = await authorize(slug);
  if (!auth.ok) return { ok: false, message: auth.result.message };
  const parsedFilters = auditFiltersSchema.safeParse(filters);
  const parsedCursor = before === null ? { success: true as const, data: null } : auditCursorSchema.safeParse(before);
  if (!parsedFilters.success || !parsedCursor.success) {
    return { ok: false, message: "Filtros inválidos. Revise o período informado." };
  }
  return getAuditPage(auth.ctx.restaurantId, parsedFilters.data, parsedCursor.data);
}
