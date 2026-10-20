"use server";

import { revalidatePath } from "next/cache";
import { requirePlatformAdmin } from "@/lib/auth/guards";
import { getPublicEnvStatus } from "@/lib/env";
import { createClient } from "@/lib/supabase/server";
import {
  createRestaurantSchema,
  idSchema,
  supportSessionSchema,
  suspendSchema,
  toFieldErrors,
} from "./schemas";
import type { ActionResult } from "./types";

/**
 * Server Actions da plataforma. A autoridade é o banco: as RPCs conferem
 * superadmin/suporte; aqui só exigimos sessão de administrador e traduzimos erros.
 */

type Failure = Extract<ActionResult, { ok: false }>;
type DbError = { message?: string; code?: string } | null | undefined;

const FORBIDDEN_MESSAGE = "Seu perfil não tem permissão para esta ação. Apenas superadministradores alteram restaurantes.";

const ERRORS: ReadonlyArray<readonly [string, string]> = [
  [
    "owner_not_found",
    "Nenhuma conta foi encontrada com este e-mail. O dono precisa criar a conta antes de o restaurante ser criado.",
  ],
  ["slug_unavailable", "Este endereço já está em uso. Escolha outro."],
  ["invalid_slug", "Endereço inválido ou reservado. Use de 3 a 63 letras minúsculas, números e hífen e escolha outro."],
  ["invalid_name", "Nome inválido. Use de 2 a 120 caracteres."],
  ["invalid_email", "E-mail inválido."],
  ["invalid_reason", "Motivo inválido. Use de 10 a 500 caracteres."],
  ["invalid_duration", "Duração inválida. Escolha 15, 30 ou 60 minutos."],
  ["invalid_status", "Situação inválida."],
  ["restaurant_not_found", "Restaurante não encontrado."],
  ["not_authenticated", "Sua sessão expirou. Entre novamente."],
  ["forbidden", FORBIDDEN_MESSAGE],
];

function failure(error: DbError): Failure {
  const code = error?.code;
  if (code === "PGRST301" || code === "PGRST303") return { ok: false, message: "Sua sessão expirou. Entre novamente." };
  if (code === "PGRST202" || code === "42883") {
    return { ok: false, message: "Esta operação ainda não está disponível neste ambiente." };
  }
  const message = (error?.message ?? "").toLowerCase();
  const hit = ERRORS.find(([key]) => message.includes(key));
  if (hit) return { ok: false, message: hit[1] };
  if (code === "42501") return { ok: false, message: FORBIDDEN_MESSAGE };
  return { ok: false, message: "Não foi possível concluir a operação agora. Tente novamente em instantes." };
}

async function gate(): Promise<Failure | null> {
  if (!getPublicEnvStatus().ok) return { ok: false, message: "O Supabase ainda não está configurado neste ambiente." };
  await requirePlatformAdmin("/platform/restaurants");
  return null;
}

export async function createRestaurantAction(input: {
  name: string;
  slug: string;
  ownerEmail: string;
}): Promise<ActionResult> {
  const blocked = await gate();
  if (blocked) return blocked;
  const parsed = createRestaurantSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, message: "Revise os campos destacados.", fieldErrors: toFieldErrors(parsed.error) };
  }
  const supabase = await createClient();
  const { error } = await supabase.rpc("platform_create_restaurant", {
    p_name: parsed.data.name,
    p_slug: parsed.data.slug,
    p_owner_email: parsed.data.ownerEmail,
  });
  if (error) {
    const result = failure(error);
    const lower = (error.message ?? "").toLowerCase();
    const field = lower.includes("slug") ? "slug" : lower.includes("owner") ? "ownerEmail" : lower.includes("invalid_name") ? "name" : null;
    return field ? { ...result, fieldErrors: { [field]: result.message } } : result;
  }
  revalidatePath("/platform/restaurants");
  revalidatePath("/platform/dashboard");
  return { ok: true, message: `Restaurante "${parsed.data.name}" criado.` };
}

async function setStatus(id: string, status: "active" | "suspended", reason: string | null): Promise<ActionResult> {
  const supabase = await createClient();
  const { error } = await supabase.rpc("platform_set_restaurant_status", {
    p_restaurant: id,
    p_status: status,
    p_reason: reason,
  });
  if (error) return failure(error);
  revalidatePath("/platform/restaurants");
  revalidatePath(`/platform/restaurants/${id}`);
  revalidatePath("/platform/dashboard");
  return {
    ok: true,
    message: status === "suspended" ? "Restaurante suspenso. A equipe perdeu o acesso." : "Restaurante reativado.",
  };
}

export async function suspendRestaurantAction(id: string, input: { reason: string }): Promise<ActionResult> {
  const blocked = await gate();
  if (blocked) return blocked;
  const parsedId = idSchema.safeParse(id);
  if (!parsedId.success) return { ok: false, message: parsedId.error.issues[0].message };
  const parsed = suspendSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, message: "Revise o campo destacado.", fieldErrors: { reason: parsed.error.issues[0].message } };
  }
  return setStatus(parsedId.data, "suspended", parsed.data.reason);
}

export async function reactivateRestaurantAction(id: string): Promise<ActionResult> {
  const blocked = await gate();
  if (blocked) return blocked;
  const parsedId = idSchema.safeParse(id);
  if (!parsedId.success) return { ok: false, message: parsedId.error.issues[0].message };
  return setStatus(parsedId.data, "active", null);
}

export async function openSupportSessionAction(
  id: string,
  input: { reason: string; minutes: number },
): Promise<ActionResult> {
  const blocked = await gate();
  if (blocked) return blocked;
  const parsedId = idSchema.safeParse(id);
  if (!parsedId.success) return { ok: false, message: parsedId.error.issues[0].message };
  const parsed = supportSessionSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, message: "Revise os campos destacados.", fieldErrors: toFieldErrors(parsed.error) };
  }
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("open_support_session", {
    p_restaurant: parsedId.data,
    p_reason: parsed.data.reason,
    p_minutes: parsed.data.minutes,
  });
  if (error) return failure(error);
  const sessionId = typeof data === "string" && idSchema.safeParse(data).success ? data : null;
  if (!sessionId) {
    return { ok: false, message: "A sessão foi aberta, mas não foi possível obter o identificador. Consulte a área de Suporte." };
  }
  revalidatePath("/platform/dashboard");
  revalidatePath("/platform/support");
  revalidatePath(`/platform/restaurants/${parsedId.data}`);
  return { ok: true, message: "Sessão de suporte aberta.", data: { sessionId } };
}
