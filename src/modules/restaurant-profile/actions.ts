"use server";

import { revalidatePath, updateTag } from "next/cache";
import { requireRestaurantAccess } from "@/lib/auth/guards";
import { getPublicEnvStatus } from "@/lib/env";
import { GENERIC_ERROR_MESSAGE, RPC_ERROR_MESSAGES, rpcErrorMessage } from "@/lib/errors";
import { createClient } from "@/lib/supabase/server";
import type { AppSupabaseClient } from "@/lib/supabase/types";
import { storefrontMenuTag } from "@/modules/menu/tags";
import { normalizeOriginList } from "./format";
import { contactSchema, fieldErrorsOf, formToRecord, originsInputSchema, slugSchema } from "./schemas";
import type { ActionResult } from "./types";

/**
 * Server Actions de /app/[slug]/restaurante. Toda ação resolve o restaurante
 * pelo guard (`restaurant.settings.manage`) a partir do slug; nenhum
 * `restaurant_id` vem do cliente. A RLS (`has_permission`) também valida.
 */

type Context = { restaurantId: string; slug: string; supabase: AppSupabaseClient };
type Failure = Extract<ActionResult, { ok: false }>;
type Authorization = { ok: true; ctx: Context } | { ok: false; result: Failure };

async function authorize(slug: string): Promise<Authorization> {
  if (!getPublicEnvStatus().ok) {
    return {
      ok: false,
      result: { ok: false, message: "O Supabase ainda não está configurado neste ambiente." },
    };
  }
  const parsedSlug = slugSchema.safeParse(slug);
  if (!parsedSlug.success) {
    return { ok: false, result: { ok: false, message: "Restaurante inválido." } };
  }
  const access = await requireRestaurantAccess(parsedSlug.data, {
    area: "app",
    permission: "restaurant.settings.manage",
  });
  const supabase = await createClient();
  return {
    ok: true,
    ctx: { restaurantId: access.restaurant.restaurant_id, slug: access.restaurant.slug, supabase },
  };
}

type DbError = { message?: string; code?: string } | null | undefined;

/** CHECK violations: a mensagem do Postgres cita o nome da constraint. */
function checkViolationMessage(message: string | undefined): string {
  if (message?.includes("whatsapp_fmt")) {
    return "WhatsApp inválido. Use DDD + número, por exemplo (11) 91234-5678.";
  }
  if (message?.includes("phone_fmt")) {
    return "Telefone inválido. Use DDD + número, por exemplo (11) 3456-7890.";
  }
  if (message?.includes("address_len")) return "Endereço muito longo (máximo de 200 caracteres).";
  if (message?.includes("storefront_url_fmt")) {
    return "Endereço da vitrine inválido. Use https:// e no máximo 200 caracteres.";
  }
  if (message?.includes("storefront_origins_valid")) {
    return "Domínios inválidos: use até 5 endereços https exatos, sem repetir, sem curinga e sem caminho.";
  }
  return "Algum dos valores informados não é aceito. Revise o formulário.";
}

/** Converte erros do banco em mensagens PT-BR. Mensagens cruas nunca saem daqui. */
function failure(error: DbError, fallback: string = GENERIC_ERROR_MESSAGE): Failure {
  const code = error?.code;
  if (code === "42501") return { ok: false, message: RPC_ERROR_MESSAGES.forbidden };
  if (code === "PGRST301" || code === "PGRST303") {
    return { ok: false, message: RPC_ERROR_MESSAGES.not_authenticated };
  }
  if (code === "23514") return { ok: false, message: checkViolationMessage(error?.message) };
  return { ok: false, message: rpcErrorMessage(error, fallback) };
}

function revalidateProfile(ctx: Context, options: { menu: boolean }): void {
  revalidatePath(`/app/${ctx.slug}/restaurante`);
  if (options.menu) {
    // O contato aparece no cardápio público (public_menu).
    revalidatePath(`/r/${ctx.slug}`, "layout");
    updateTag(storefrontMenuTag(ctx.slug));
  }
}

type SettingsPatch = Record<string, string | string[] | null>;

/** UPDATE da linha 1:1; se ela não existir (restaurante antigo), cria. */
async function writeSettings(ctx: Context, patch: SettingsPatch): Promise<Failure | null> {
  const { data, error } = await ctx.supabase
    .from("restaurant_settings")
    .update(patch)
    .eq("restaurant_id", ctx.restaurantId)
    .select("restaurant_id");
  if (error) return failure(error, "Não foi possível salvar agora.");
  if (data && data.length > 0) return null;

  const { error: insertError } = await ctx.supabase
    .from("restaurant_settings")
    .insert({ restaurant_id: ctx.restaurantId, ...patch });
  return insertError ? failure(insertError, "Não foi possível salvar agora.") : null;
}

export async function saveContactAction(slug: string, formData: FormData): Promise<ActionResult> {
  const auth = await authorize(slug);
  if (!auth.ok) return auth.result;
  const { ctx } = auth;

  const parsed = contactSchema.safeParse(formToRecord(formData));
  if (!parsed.success) {
    return { ok: false, message: "Revise os campos destacados.", fieldErrors: fieldErrorsOf(parsed.error) };
  }
  const { whatsapp, phone, addressText, storefrontUrl } = parsed.data;

  const problem = await writeSettings(ctx, {
    whatsapp,
    phone,
    address_text: addressText,
    storefront_url: storefrontUrl,
  });
  if (problem) return problem;

  revalidateProfile(ctx, { menu: true });
  return { ok: true, message: "Contato e vitrine atualizados." };
}

export async function saveOriginsAction(slug: string, origins: string[]): Promise<ActionResult> {
  const auth = await authorize(slug);
  if (!auth.ok) return auth.result;
  const { ctx } = auth;

  const input = originsInputSchema.safeParse(origins);
  if (!input.success) return { ok: false, message: "Lista de domínios inválida." };
  const normalized = normalizeOriginList(input.data);
  if (!normalized.ok) return { ok: false, message: normalized.message };

  const problem = await writeSettings(ctx, { storefront_origins: normalized.value });
  if (problem) return problem;

  revalidateProfile(ctx, { menu: false });
  return {
    ok: true,
    message: "Domínios autorizados atualizados.",
    warning:
      normalized.value.length > 0
        ? "A API pode levar cerca de 1 minuto para reconhecer a mudança."
        : undefined,
  };
}
