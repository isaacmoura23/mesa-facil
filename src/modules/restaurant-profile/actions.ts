"use server";

import { revalidatePath, updateTag } from "next/cache";
import { requireRestaurantAccess } from "@/lib/auth/guards";
import { getPublicEnvStatus } from "@/lib/env";
import { GENERIC_ERROR_MESSAGE, RPC_ERROR_MESSAGES, rpcErrorMessage } from "@/lib/errors";
import { createClient } from "@/lib/supabase/server";
import { PUBLIC_BUCKET } from "@/lib/storage";
import { ALLOWED_IMAGE_TYPES, MAX_IMAGE_BYTES } from "@/modules/menu/image";
import { z } from "zod";
import type { AppSupabaseClient } from "@/lib/supabase/types";
import { storefrontMenuTag } from "@/modules/menu/tags";
import { normalizeOriginList } from "./format";
import { isOwnLogoPath } from "./logo";
import {
  contactSchema,
  establishmentSchema,
  fieldErrorsOf,
  formToRecord,
  originsInputSchema,
  slugSchema,
  type EstablishmentInput,
} from "./schemas";
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
  if (message?.includes("timezone")) return "Fuso horário inválido.";
  if (message?.includes("logo_path")) return "Logo inválida. Envie o arquivo novamente.";
  if (message?.includes("name")) return "Nome inválido. Use de 2 a 120 caracteres.";
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
  const { whatsapp, phone, addressText, storefrontUrl, notice } = parsed.data;

  const problem = await writeSettings(ctx, {
    whatsapp,
    phone,
    address_text: addressText,
    storefront_url: storefrontUrl,
    storefront_notice: notice,
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

const storageObjectSchema = z.object({
  name: z.string(),
  metadata: z
    .object({ size: z.number().optional(), mimetype: z.string().optional() })
    .nullable()
    .optional(),
});

/** Confere no Storage se o logo enviado existe e respeita tipo e tamanho. */
async function verifyUploadedLogo(ctx: Context, path: string): Promise<string | null> {
  const lastSlash = path.lastIndexOf("/");
  const fileName = path.slice(lastSlash + 1);
  const { data, error } = await ctx.supabase.storage
    .from(PUBLIC_BUCKET)
    .list(path.slice(0, lastSlash), { search: fileName, limit: 5 });
  if (error) return "Não foi possível conferir a logo enviada.";

  const objects = z.array(storageObjectSchema).safeParse(data);
  const found = objects.success ? objects.data.find((item) => item.name === fileName) : undefined;
  if (!found) return "Não encontramos a logo enviada. Envie o arquivo novamente.";

  const size = found.metadata?.size;
  const mimetype = found.metadata?.mimetype;
  if (
    (typeof size === "number" && size > MAX_IMAGE_BYTES) ||
    (typeof mimetype === "string" && !ALLOWED_IMAGE_TYPES.includes(mimetype))
  ) {
    await ctx.supabase.storage.from(PUBLIC_BUCKET).remove([path]);
    return "A logo enviada não atende aos requisitos (JPG, PNG, WebP ou AVIF, até 5 MB).";
  }
  return null;
}

/**
 * Nome, fuso horário e logo. O arquivo da logo já foi enviado pelo navegador (cliente do
 * usuário, RLS do Storage) para `restaurants/{id}/logo/{uuid}.{ext}`; aqui o caminho é
 * conferido, salvo e só então o arquivo antigo é removido. Slug e status NÃO são editáveis.
 */
export async function saveEstablishmentAction(slug: string, input: EstablishmentInput): Promise<ActionResult> {
  const auth = await authorize(slug);
  if (!auth.ok) return auth.result;
  const { ctx } = auth;

  const parsed = establishmentSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, message: "Revise os campos destacados.", fieldErrors: fieldErrorsOf(parsed.error) };
  }
  const { name, timezone, logoPath, removeLogo } = parsed.data;

  const newLogo = logoPath !== null && isOwnLogoPath(logoPath, ctx.restaurantId) ? logoPath : null;
  if (logoPath !== null && newLogo === null) {
    return { ok: false, message: "Logo inválida. Envie o arquivo novamente.", fieldErrors: { logo: "Logo inválida." } };
  }
  if (newLogo) {
    const problem = await verifyUploadedLogo(ctx, newLogo);
    if (problem) return { ok: false, message: problem, fieldErrors: { logo: problem } };
  }

  const before = await ctx.supabase.from("restaurants").select("logo_path").eq("id", ctx.restaurantId).maybeSingle();
  const oldLogo = typeof before.data?.logo_path === "string" ? before.data.logo_path : null;

  const patch: Record<string, string | null> = { name, timezone };
  if (newLogo) patch.logo_path = newLogo;
  else if (removeLogo) patch.logo_path = null;

  const { data, error } = await ctx.supabase
    .from("restaurants")
    .update(patch)
    .eq("id", ctx.restaurantId)
    .select("id");
  if (error || !data?.length) {
    // Não salvou: não deixa o arquivo novo órfão no bucket.
    if (newLogo) await ctx.supabase.storage.from(PUBLIC_BUCKET).remove([newLogo]);
    return error
      ? failure(error, "Não foi possível salvar agora.")
      : { ok: false, message: "Não foi possível salvar agora." };
  }

  // Só depois de salvar o novo caminho o arquivo antigo é removido (melhor esforço).
  const logoChanged = "logo_path" in patch && patch.logo_path !== oldLogo;
  if (oldLogo && logoChanged && isOwnLogoPath(oldLogo, ctx.restaurantId)) {
    await ctx.supabase.storage.from(PUBLIC_BUCKET).remove([oldLogo]);
  }

  revalidatePath(`/app/${ctx.slug}`, "layout");
  revalidatePath(`/r/${ctx.slug}`, "layout");
  updateTag(storefrontMenuTag(ctx.slug));
  return {
    ok: true,
    message: "Dados do estabelecimento atualizados.",
    warning: "Nome, logo e fuso aparecem na vitrine na hora. Os pedidos já feitos não mudam.",
  };
}
